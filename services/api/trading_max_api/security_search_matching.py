"""Rank search suggestions without turning spelling similarity into identity."""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

_LEGAL_SUFFIXES = {
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "co",
    "company",
    "plc",
    "ltd",
    "limited",
    "class",
    "cl",
}
_US_EXCHANGES = {"NMS", "NGM", "NCM", "NGS", "NYQ", "ASE", "PCX", "BTS", "PNK", "OQB", "OQX"}
_TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$")
_FUND_NAME = re.compile(r"\b(etf|etp|fund|trust|leveraged|leverage shares)\b", re.I)


def company_key(name: str) -> str:
    words = re.findall(r"[^\W_]+", name.casefold())
    while words and (words[-1] in _LEGAL_SUFFIXES or len(words[-1]) == 1):
        words.pop()
    return " ".join(words)


def match_score(query: str, name: str, ticker: str = "") -> float:
    """Exact symbols, company names, prefixes, then conservative fuzzy matches."""
    if ticker and query.casefold() == ticker.casefold():
        return 1.0
    key = company_key(query)
    name_key = company_key(name)
    if not key or not name_key:
        return 0.0
    keys = {name_key, *(word for word in name_key.split() if word not in _LEGAL_SUFFIXES)}
    if key in keys:
        return 0.99
    prefixes = [candidate for candidate in keys if candidate.startswith(key)]
    if ticker and ticker.casefold().startswith(query.casefold()):
        prefixes.append(ticker.casefold())
    if prefixes:
        # "appl" is closer to Apple than Applied; alphabetical ticker order
        # must not crowd the nearest completion out of the candidate list.
        return 0.96 + 0.025 * max(len(key) / len(candidate) for candidate in prefixes)
    if len(key) < 3:
        return 0.0
    # A shared suffix (MicroStrategy / RoboStrategy) is not enough evidence.
    similarity = max(
        difflib.SequenceMatcher(None, key, candidate).ratio()
        for candidate in {*keys, ticker.casefold()}
        if candidate
    )
    return similarity if similarity >= 0.82 else 0.0


@dataclass(frozen=True)
class SearchCandidate:
    query: str
    name: str
    score: float
    ticker: str = ""


def index_candidates(query: str, entries: list[tuple[str, str]]) -> list[SearchCandidate]:
    candidates = [
        SearchCandidate(ticker, name, score, ticker)
        for name, ticker in entries
        if (score := match_score(query, name, ticker)) > 0
    ]
    return sorted(candidates, key=lambda item: (-item.score, item.ticker))[:3]


def quote_candidates(query: str, rows: list[dict]) -> list[SearchCandidate]:
    """Use provider search aliases, but require OpenFIGI verification afterwards.

    Foreign listings may expose both a former and a current company name. Use
    that name pair to find the US listing, never strip a foreign symbol suffix
    and assume it is the US ticker.
    """
    candidates: list[SearchCandidate] = []
    for position, row in enumerate(rows):
        if row.get("quoteType") != "EQUITY":
            continue
        names = [str(row.get(key) or "").strip() for key in ("longname", "shortname")]
        if not any(names) or any(_FUND_NAME.search(name) for name in names):
            continue
        ticker = str(row.get("symbol") or "").strip().upper()
        if row.get("exchange") in _US_EXCHANGES and _TICKER.fullmatch(ticker):
            # The non-fuzzy provider search also recognizes brand/old names
            # whose spelling has no relationship to the current legal name.
            score = max(0.95, *(match_score(query, name, ticker) for name in names))
            # Use provider relevance to break ties between equally close names.
            score = min(1.0, score + 0.004 / (position + 1))
            candidates.append(SearchCandidate(ticker, names[0] or names[1], score, ticker))
        elif all(names) and max(match_score(query, name) for name in names) >= 0.96:
            for name in names:
                key = company_key(name)
                if key and match_score(query, name) < 0.96:
                    candidates.append(SearchCandidate(key, name, 0.97))
    return candidates


def merge_candidates(candidates: list[SearchCandidate]) -> list[SearchCandidate]:
    unique: dict[str, SearchCandidate] = {}
    for candidate in sorted(candidates, key=lambda item: (-item.score, item.query)):
        unique.setdefault(candidate.query.casefold(), candidate)
    exact = [candidate for candidate in unique.values() if candidate.score == 1.0]
    return exact or list(unique.values())[:3]
