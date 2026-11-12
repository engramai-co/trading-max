"""Issuer disclosure history derived only from observed published evidence."""

from typing import Literal

from trading_max.analytics.etf_projection import ETFPortfolio
from trading_max.domain.contracts import DomainModel

ETF_JOURNAL_KEY = "account/etf_journal.json"


class ETFDisclosure(DomainModel):
    kind: Literal["holdings", "index-change"]
    value: str
    previous_value: str | None = None
    observed_at: str
    effective_at: str | None = None
    source_url: str | None = None


def update_etf_journal(
    journal: dict[str, list[dict]],
    previous: ETFPortfolio,
    current: ETFPortfolio,
    observed_at: str,
) -> dict[str, list[dict]]:
    by_isin = {fund.isin: fund for fund in previous.funds}
    updated = dict(journal)
    for fund in current.funds:
        if not fund.isin:
            continue
        old = by_isin.get(fund.isin)
        events = list(updated.get(fund.isin, []))
        index = fund.evidence.get("index_name")
        if (
            old
            and old.index_name
            and fund.index_name
            and old.index_name != fund.index_name
            and index
        ):
            events.append(
                ETFDisclosure(
                    kind="index-change",
                    value=fund.index_name,
                    previous_value=old.index_name,
                    observed_at=observed_at,
                    effective_at=index.effective_at,
                    source_url=index.source_url,
                ).model_dump()
            )
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
                ).model_dump()
            )
        if events:
            updated[fund.isin] = events[-100:]
    return updated
