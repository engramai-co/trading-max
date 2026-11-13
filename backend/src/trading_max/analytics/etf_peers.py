"""Precompute observed peers from exact issuer share-class evidence."""

import math
import re
import unicodedata
from datetime import date, datetime

from pydantic import Field

from trading_max.analytics.etf_projection import (
    ETFOverlap,
    ETFPortfolio,
    ETFTracking,
    recent,
    tracking,
)
from trading_max.domain.contracts import DomainModel
from trading_max.domain.etf import FundEvidence, FundShareClass
from trading_max.reference.indices import issuer_benchmark_id


class ETFPeerValue(DomainModel):
    value: float
    basis: str
    evidence: FundEvidence


class ETFPeer(DomainModel):
    isin: str
    name: str
    source_url: str
    held_ticker: str | None = None
    fee: ETFPeerValue | None = None
    share_class_size: ETFPeerValue | None = None
    tracking: ETFTracking | None = None
    overlap: ETFOverlap | None = None
    overlap_evidence: FundEvidence | None = None


class ETFPeerRank(DomainModel):
    percentile: float = Field(ge=0, le=100)
    count: int = Field(ge=2)
    comparable_isins: list[str]


class ETFPeerComparison(DomainModel):
    benchmark: str
    domicile: str
    hedging: str
    income_use: str
    published_at: datetime
    funds: list[ETFPeer]
    ranks: dict[str, ETFPeerRank] = Field(default_factory=dict)


SUPPORTED_BENCHMARKS = frozenset(
    {
        "msci-world",
        "msci-world-ex-usa",
        "msci-em",
        "msci-em-imi",
        "msci-usa-momentum",
        "ftse-all-world",
        "sp-500",
        "nasdaq-100",
    }
)


def _text(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold()))


def _cohort(profile: FundShareClass) -> tuple[str, str, str, str] | None:
    values = (profile.index_name, profile.domicile, profile.hedging, profile.income_use)
    keys = ("index_name", "domicile", "hedging", "income_use")
    if not all(
        value and (fact := profile.evidence.get(key)) and fact.coverage == "available"
        for key, value in zip(keys, values, strict=True)
    ):
        return None
    benchmark = _text(profile.index_name or "")
    # Family aliases are only a scope gate; they must never join different
    # price, net, gross, capped, ESG, or otherwise distinct benchmark variants.
    family = issuer_benchmark_id(profile.index_name)
    allowed = (
        family in SUPPORTED_BENCHMARKS
        or re.fullmatch(r"msci usa momentum(?: factor)?(?: index)?(?: usd)?(?: net)?", benchmark)
        or re.fullmatch(
            r"(?:ftse all world|msci emerging markets|msci emerging markets imi)"
            r"(?: index)?(?: usd)? (?:net|gross)(?: total return)?",
            benchmark,
        )
        or "semiconductor" in benchmark.split()
        or "semiconductors" in benchmark.split()
    )
    if not allowed:
        return None
    return tuple(_text(value or "") for value in values)


def _fact(profile: FundShareClass, key: str, value, basis: str | None) -> ETFPeerValue | None:
    evidence = profile.evidence.get(key)
    if (
        evidence
        and evidence.coverage == "available"
        and basis
        and value is not None
        and math.isfinite(value)
        and value >= 0
    ):
        return ETFPeerValue(value=value, basis=basis, evidence=evidence)
    return None


def _comparison_value(row: ETFPeer, metric: str, today: date):
    if metric == "fee" and row.fee:
        return row.fee.basis.upper(), row.fee.value
    if metric == "shareClassSize" and row.share_class_size:
        stamp = row.share_class_size.evidence.effective_at
        if recent(stamp, today, 45):
            return (row.share_class_size.basis, stamp), row.share_class_size.value
    if metric == "tracking" and row.tracking:
        fact = row.tracking
        if fact.state == "available" and fact.difference_pp is not None:
            return (
                fact.period_end,
                fact.currency,
                fact.benchmark_currency,
                fact.nav_hedging,
                fact.benchmark_hedging,
            ), fact.difference_pp
    if metric == "overlap" and row.overlap:
        fact = row.overlap
        if (
            fact.state == "available"
            and fact.dates_valid
            and fact.value is not None
            and (fact.fund_coverage or 0) >= 0.90
            and (fact.rest_coverage or 0) >= 0.90
        ):
            return fact.portfolio_as_of, fact.value
    return None


def _ranks(target: ETFPeer, peers: list[ETFPeer], today: date) -> dict[str, ETFPeerRank]:
    ranks = {}
    for metric in ("fee", "shareClassSize", "tracking", "overlap"):
        current = _comparison_value(target, metric, today)
        if current is None:
            continue
        basis, value = current
        comparable = [
            (row.isin, comparison[1])
            for row in peers
            if row.isin != target.isin
            and (comparison := _comparison_value(row, metric, today)) is not None
            and comparison[0] == basis
        ]
        if comparable:
            # Rank the raw number, without implying higher is always better.
            position = sum(
                0.5 if other == value else float(other < value) for _, other in comparable
            )
            ranks[metric] = ETFPeerRank(
                percentile=round(100 * position / len(comparable), 2),
                count=len(comparable) + 1,
                comparable_isins=[target.isin, *(isin for isin, _ in comparable)],
            )
    return ranks


def project_peers(
    portfolio: ETFPortfolio,
    profiles: dict[str, FundShareClass],
    candidates: set[str],
    now: datetime,
) -> dict[str, ETFPeerComparison]:
    """Restrict observations to evidenced groups anchored by a held share class."""
    held = {fund.isin: fund for fund in portfolio.funds if fund.isin}
    keys = {identity: _cohort(profile) for identity, profile in profiles.items()}
    eligible = {keys[identity] for identity in held if identity in keys} - {None}
    groups = {}
    today = now.date()
    for identity, profile in sorted(profiles.items()):
        key = keys[identity]
        if key not in eligible or (identity not in candidates and identity not in held):
            continue
        reading = held.get(identity)
        size = profile.share_class_size
        difference = tracking(profile, today)
        # Generic benchmark names alone do not identify a gross/net variant.
        is_total_return = any(word in key[0].split() for word in ("net", "gross"))
        row = ETFPeer(
            isin=identity,
            name=profile.name or identity,
            source_url=profile.evidence["index_name"].source_url,
            held_ticker=reading.tickers[0] if reading and reading.tickers else None,
            fee=_fact(profile, "expense_ratio", profile.expense_ratio, profile.fee_basis),
            share_class_size=_fact(
                profile,
                "share_class_size",
                size.amount if size else None,
                size.currency if size else None,
            ),
            tracking=difference
            if is_total_return and difference.difference_pp is not None
            else None,
            overlap=reading.overlap if reading and reading.overlap.value is not None else None,
            overlap_evidence=reading.evidence.get("holdings_date") if reading else None,
        )
        groups.setdefault(key, []).append(row)

    result = {}
    for identity in held:
        key = keys.get(identity)
        peers = groups.get(key, [])
        if len(peers) < 2:
            continue
        target = next(row for row in peers if row.isin == identity)
        rows = [target, *(row for row in peers if row.isin != identity)]
        profile = profiles[identity]
        result[identity] = ETFPeerComparison(
            benchmark=profile.index_name,
            domicile=profile.domicile,
            hedging=profile.hedging,
            income_use=profile.income_use,
            published_at=now,
            funds=rows,
            ranks=_ranks(target, rows, today),
        )
    return result
