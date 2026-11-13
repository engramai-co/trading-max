"""Issuer disclosure history derived only from observed published evidence."""

import unicodedata
from datetime import UTC, datetime
from typing import Literal

from trading_max.analytics.etf_projection import ETFPortfolio, ETFReading
from trading_max.domain.contracts import DomainModel
from trading_max.domain.etf import FundEvidence

ETF_JOURNAL_KEY = "account/etf_journal.json"
ETF_BENCHMARKS_KEY = "account/etf_benchmark_observations.json"


class ETFDisclosure(DomainModel):
    kind: Literal["holdings", "index-change"]
    value: str
    previous_value: str | None = None
    observed_at: str
    effective_at: str | None = None
    source_url: str | None = None
    evidence: FundEvidence | None = None
    previous_evidence: FundEvidence | None = None


class BenchmarkObservation(DomainModel):
    value: str
    evidence: FundEvidence


def _benchmark(fund: ETFReading) -> BenchmarkObservation | None:
    index = fund.evidence.get("index_name")
    if fund.index_name and index and index.coverage == "available" and index.source_url:
        return BenchmarkObservation(value=fund.index_name, evidence=index)
    return None


def _name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _clock(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)


def update_etf_journal(
    journal: dict[str, list[dict]],
    previous: ETFPortfolio,
    current: ETFPortfolio,
    observed_at: str,
    *,
    benchmarks: dict[str, BenchmarkObservation] | None = None,
) -> dict[str, list[dict]]:
    # The baseline survives missing evidence, a sale and a later repurchase.
    # Seed the first new snapshot with the immediately preceding publication.
    if benchmarks is None:
        benchmarks = {}
    for fund in previous.funds:
        if fund.isin and fund.isin not in benchmarks and (baseline := _benchmark(fund)):
            benchmarks[fund.isin] = baseline
    updated = dict(journal)
    for fund in current.funds:
        if not fund.isin:
            continue
        events = list(updated.get(fund.isin, []))
        old = benchmarks.get(fund.isin)
        index = _benchmark(fund)
        if index and (
            old is None or _clock(index.evidence.fetched_at) >= _clock(old.evidence.fetched_at)
        ):
            if old and _name(old.value) != _name(index.value):
                events.append(
                    ETFDisclosure(
                        kind="index-change",
                        value=index.value,
                        previous_value=old.value,
                        observed_at=observed_at,
                        effective_at=index.evidence.effective_at,
                        source_url=index.evidence.source_url,
                        evidence=index.evidence,
                        previous_evidence=old.evidence,
                    ).model_dump()
                )
            benchmarks[fund.isin] = index
        stamp = fund.overlap.fund_holdings_date
        evidence = fund.evidence.get("holdings_date")
        if (
            stamp
            and evidence
            and fund.holdings_state == "available"
            and not any(event["kind"] == "holdings" and event["value"] == stamp for event in events)
        ):
            events.append(
                ETFDisclosure(
                    kind="holdings",
                    value=stamp,
                    observed_at=observed_at,
                    effective_at=stamp,
                    source_url=evidence.source_url,
                    evidence=evidence,
                ).model_dump()
            )
        if events:
            # Retain every observed change; only routine holdings notices age out.
            recent_holdings = [event["value"] for event in events if event["kind"] == "holdings"][
                -100:
            ]
            updated[fund.isin] = [
                event
                for event in events
                if event["kind"] != "holdings" or event["value"] in recent_holdings
            ]
    return updated
