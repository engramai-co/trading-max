"""Bounded EDGAR reads for dated, USD-denominated diluted EPS evidence."""

from __future__ import annotations

import json
import re
import threading
import time
from collections import defaultdict
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path
from typing import Any

import httpx

from trading_max.infrastructure.history_chunks import atomic_bytes
from trading_max.infrastructure.singleflight import SingleFlightCache

from .facts import number
from .trailing_pe import DilutedEps, EpsFiling

TICKER_MAP = "https://www.sec.gov/files/company_tickers.json"
USER_AGENT = "TradingMax research https://github.com/engramai-co/trading-max"
MAX_BYTES = 32_000_000
FILINGS_TTL_SECONDS = 86400
FORMS = {"10-Q", "10-K", "10-Q/A", "10-K/A"}
SYMBOL = re.compile(r"[A-Z][A-Z0-9]{0,8}(?:-[A-Z0-9]{1,3})?")
ACCESSION = re.compile(r"[0-9]{10}-[0-9]{2}-[0-9]{6}")
_request_lock = threading.Lock()
_last_request = 0.0


def _get_json(url: str) -> dict[str, Any]:
    global _last_request
    with _request_lock:
        time.sleep(max(0, 0.25 - (time.monotonic() - _last_request)))
        _last_request = time.monotonic()
    with httpx.stream("GET", url, headers={"User-Agent": USER_AGENT}, timeout=10) as response:
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_bytes(64 * 1024):
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise ValueError("SEC response exceeds size limit")
    payload = json.loads(data)
    if not isinstance(payload, dict):
        raise ValueError("SEC payload is not an object")
    return payload


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _acceptance(value: Any) -> datetime | None:
    try:
        timestamp = datetime.fromisoformat(value)
        return timestamp if timestamp.utcoffset() is not None and "T" in value else None
    except (TypeError, ValueError):
        return None


def eps_filings(
    companyfacts: dict[str, Any], submissions: list[dict[str, Any]], *, since: date
) -> list[EpsFiling]:
    """Join by accession; do not substitute filing dates for missing timestamps."""
    by_accession: dict[str, tuple[datetime, date, str]] = {}
    for source in submissions:
        for accession, raw_time, raw_end, form in zip(
            source.get("accessionNumber", []),
            source.get("acceptanceDateTime", []),
            source.get("reportDate", []),
            source.get("form", []),
            strict=False,
        ):
            if (
                form not in FORMS
                or not isinstance(accession, str)
                or not ACCESSION.fullmatch(accession)
            ):
                continue
            accepted = _acceptance(raw_time)
            report_end = _date(raw_end)
            if accepted and report_end and accepted.date() >= since:
                by_accession[accession] = (accepted, report_end, form)

    facts = (
        companyfacts.get("facts", {})
        .get("us-gaap", {})
        .get("EarningsPerShareDiluted", {})
        .get("units", {})
        .get("USD/shares", [])
    )
    by_filing: dict[str, list[DilutedEps]] = defaultdict(list)
    for fact in facts:
        accession = fact.get("accn")
        if accession not in by_accession or fact.get("form") != by_accession[accession][2]:
            continue
        start, end = _date(fact.get("start")), _date(fact.get("end"))
        if start and end and start <= end <= by_accession[accession][1]:
            by_filing[accession].append(DilutedEps(start, end, number(fact.get("val"))))

    if not by_filing:
        return []
    return [
        EpsFiling(accepted, end, form.startswith("10-K"), tuple(by_filing.get(accession, ())))
        for accession, (accepted, end, form) in by_accession.items()
    ]


class SecCompanyFacts:
    def __init__(self, root: Path):
        self.root = root
        self._mappings: SingleFlightCache[int, dict[str, int]] = SingleFlightCache(1)

    def _ticker_map(self) -> dict[str, int]:
        path = self.root / "sec-company-tickers.json"

        def load() -> dict[str, int]:
            with suppress(OSError, ValueError):
                if time.time() - path.stat().st_mtime < 86400:
                    return json.loads(path.read_bytes())
            codes: dict[str, set[int]] = defaultdict(set)
            for row in _get_json(TICKER_MAP).values():
                ticker, cik = row.get("ticker"), row.get("cik_str")
                if isinstance(ticker, str) and isinstance(cik, int) and 0 < cik < 10**10:
                    codes[ticker].add(cik)
            resolved = {
                ticker: next(iter(ciks)) for ticker, ciks in codes.items() if len(ciks) == 1
            }
            atomic_bytes(path, json.dumps(resolved).encode())
            return resolved

        return self._mappings.get_or_compute(int(time.time()) // 86400, load)

    def filings(self, ticker: str, *, since: date) -> list[EpsFiling]:
        cik = self._ticker_map().get(ticker)
        if not cik:
            return []
        # Filings change a few times a quarter. Reuse a day's result instead of
        # downloading the full companyfacts document on every research run.
        cache = self.root / f"sec-eps-{cik:010d}-{ticker}.json"
        with suppress(OSError, ValueError, KeyError, TypeError):
            if time.time() - cache.stat().st_mtime < FILINGS_TTL_SECONDS:
                saved = json.loads(cache.read_bytes())
                if saved["since"] == since.isoformat():
                    return _decode_filings(saved["filings"])
        result = self._fetch_filings(cik, ticker, since=since)
        with suppress(OSError):
            atomic_bytes(
                cache,
                json.dumps(
                    {"since": since.isoformat(), "filings": _encode_filings(result)}
                ).encode(),
            )
        return result

    def _fetch_filings(self, cik: int, ticker: str, *, since: date) -> list[EpsFiling]:
        stem = f"CIK{cik:010d}"
        data = _get_json(f"https://data.sec.gov/submissions/{stem}.json")
        # Require an exact listed symbol: never equate a US receipt with foreign
        # ordinary EPS, or map an unverified symbol alias into a filing series.
        if ticker not in data.get("tickers", []):
            return []
        facts = _get_json(f"https://data.sec.gov/api/xbrl/companyfacts/{stem}.json")
        if facts.get("cik") != cik:
            return []
        filings = data.get("filings", {})
        submissions = [filings.get("recent", {})]
        archives = [
            page["name"]
            for page in filings.get("files", [])
            if isinstance(page.get("name"), str)
            and re.fullmatch(stem + r"-submissions-[0-9]+\.json", page["name"])
            and (end := _date(page.get("filingTo"))) is not None
            and end >= since
        ]
        if len(archives) > 8:
            raise ValueError("SEC submissions history exceeds page limit")
        for name in archives:
            submissions.append(_get_json(f"https://data.sec.gov/submissions/{name}"))
        return eps_filings(facts, submissions, since=since)


def _encode_filings(filings: list[EpsFiling]) -> list[dict[str, Any]]:
    return [
        {
            "accepted_at": filing.accepted_at.isoformat(),
            "report_end": filing.report_end.isoformat(),
            "annual": filing.annual,
            "observations": [
                [item.start.isoformat(), item.end.isoformat(), item.value]
                for item in filing.observations
            ],
        }
        for filing in filings
    ]


def _decode_filings(rows: list[dict[str, Any]]) -> list[EpsFiling]:
    return [
        EpsFiling(
            accepted_at=datetime.fromisoformat(row["accepted_at"]),
            report_end=date.fromisoformat(row["report_end"]),
            annual=bool(row["annual"]),
            observations=tuple(
                DilutedEps(
                    start=date.fromisoformat(start),
                    end=date.fromisoformat(end),
                    value=None if value is None else float(value),
                )
                for start, end, value in row["observations"]
            ),
        )
        for row in rows
    ]
