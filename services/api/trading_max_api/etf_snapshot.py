"""Read ETF projections from the requested immutable account snapshot."""

from contextlib import suppress
from datetime import UTC, datetime

from trading_max.analytics.etf_details import ETFDetail, etf_detail_key, etf_holdings_key
from trading_max.analytics.etf_projection import (
    ETF_SUMMARY_KEY,
    MAX_HOLDINGS_AGE_DAYS,
    MAX_TRACKING_AGE_DAYS,
    ETFPortfolio,
    ETFReading,
    recent,
)
from trading_max.analytics.lookthrough import FundSnapshot


def _freshness(fund: ETFReading) -> ETFReading:
    """Age published observations without fetching or calculating constituents."""
    today = datetime.now(UTC).date()
    if fund.tracking.state == "available" and not recent(
        fund.tracking.period_end, today, MAX_TRACKING_AGE_DAYS
    ):
        fund.tracking.state = "stale"
    fund_date_valid = recent(fund.overlap.fund_holdings_date, today, MAX_HOLDINGS_AGE_DAYS)
    if fund.holdings_state == "available" and not fund_date_valid:
        fund.holdings_state = "holdings-stale"
    if fund.overlap.dates_valid and (
        not fund_date_valid
        or any(
            not recent(stamp, today, MAX_HOLDINGS_AGE_DAYS)
            for stamp in fund.overlap.rest_holdings_dates
        )
        or not recent((fund.overlap.portfolio_as_of or "")[:10], today, MAX_HOLDINGS_AGE_DAYS)
    ):
        fund.overlap.dates_valid = False
        if fund.overlap.state == "available":
            fund.overlap.state = "stale"
    return fund


def read_etf_portfolio(store, run_id: str) -> ETFPortfolio:
    try:
        raw = store.read_json(run_id, ETF_SUMMARY_KEY)
    except FileNotFoundError:
        return ETFPortfolio(run_id=run_id)
    result = ETFPortfolio.model_validate({**raw, "runId": run_id})
    for fund in result.funds:
        _freshness(fund)
    return result


def read_etf_detail(store, run_id: str, isin: str, *, include_holdings: bool = True) -> ETFDetail:
    raw = store.read_json(run_id, etf_detail_key(isin))
    result = ETFDetail.model_validate({**raw, "runId": run_id})
    _freshness(result.reading)
    if include_holdings:
        with suppress(FileNotFoundError):
            result.holdings = FundSnapshot.model_validate(
                store.read_json(run_id, etf_holdings_key(isin))
            )
    return result
