from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from trading_max.analytics.cfd import CfdEvent, CfdLedger, analyse_cfd_ledger
from trading_max.analytics.fx import FxQuote

from services.api.trading_max_api.dashboard_models import CfdAccountReview


@pytest.mark.parametrize("has_fx", [False, True])
def test_foreign_cfd_analysis_keeps_conversion_evidence_and_nulls_in_api(has_fx):
    stamp = datetime(2026, 1, 6, 12, tzinfo=UTC)
    events = (
        CfdEvent(
            event_id="cash",
            record_type="Transaction",
            occurred_at=stamp,
            account_currency="EUR",
            transaction_type="Deposit",
            amount=Decimal(100),
        ),
        CfdEvent(
            event_id="close",
            record_type="Closed position",
            occurred_at=stamp,
            account_currency="EUR",
            instrument_currency="EUR",
            position_id="p1",
            symbol="AAA",
            direction="Long",
            units=Decimal(1),
            opened_at=stamp - timedelta(days=1),
            closed_at=stamp,
            gross_result=Decimal(25),
            result_after_fx_fee=Decimal(25),
            notional_account_currency=Decimal(100),
        ),
    )
    ledger = CfdLedger(
        parser_version="synthetic",
        source_files=(),
        raw_row_count=2,
        events=events,
        duplicate_event_count=0,
        coverage_start=stamp,
        coverage_end=stamp,
        latest_event_at=stamp,
        account_currencies=("EUR",),
    )

    def resolve(currency, at):
        return (
            FxQuote(currency, Decimal("1.25"), at - timedelta(hours=1), "synthetic")
            if has_fx
            else None
        )

    analysis = analyse_cfd_ledger(ledger, fx_resolver=resolve)
    review = CfdAccountReview.model_validate(
        {
            **analysis.to_dict(),
            "import_status": {"parser_version": ledger.parser_version},
        }
    )
    payload = review.model_dump(mode="json", by_alias=True)
    assert payload["currency"] == "GBP"
    assert payload["tradeQuality"]["tradeCount"] == 1
    assert payload["fxConversion"]["status"] == ("available" if has_fx else "unavailable")
    assert payload["monetaryData"]["status"] == "available"
    assert payload["moneyOutcome"]["endingRealisedCashEquityProxyGbp"] == (100 if has_fx else None)
    assert payload["realisedPnl"]["netRealisedPnl"] == (20 if has_fx else None)
    assert payload["tradeQuality"]["wins"] == (1 if has_fx else None)
    assert payload["notional"]["totalClosedNotional"] == (80 if has_fx else None)
    assert payload["realisedSeries"][-1]["realisedCashEquityProxy"] == (100 if has_fx else None)
