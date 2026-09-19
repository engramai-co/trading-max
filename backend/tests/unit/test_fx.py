import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pandas as pd
import pytest
import trading_max.analytics.fx as fx_module
from trading_max.analytics.fx import FxQuote, HistoricalFxResolver, resolve_fx

EVENT = datetime(2026, 1, 6, 12, tzinfo=UTC)


def test_units_and_explicit_broker_conversion_precede_provider() -> None:
    def forbidden(*_args):
        raise AssertionError("a proven broker/unit conversion must not request market FX")

    assert resolve_fx("GBP", EVENT, resolver=forbidden).to_gbp(Decimal("12.5")) == Decimal("12.5")
    assert resolve_fx("GBp", EVENT, resolver=forbidden).to_gbp(Decimal("125")) == Decimal("1.25")
    quote = resolve_fx("USD", EVENT, resolver=forbidden, broker_rate_native_per_gbp=Decimal("1.25"))
    assert quote.to_gbp(Decimal("100")) == 80
    assert quote.source == "broker-exchange-rate"
    assert quote.observed_at == EVENT


@pytest.mark.parametrize("age", [-1, 8])
def test_future_and_stale_quotes_are_unavailable(age: int) -> None:
    quote = FxQuote("USD", Decimal("1.25"), EVENT - timedelta(days=age), "fixture")
    assert resolve_fx("USD", EVENT, resolver=lambda *_args: quote) is None


@pytest.mark.parametrize("rate", ["0", "-1", "NaN", "Infinity"])
def test_invalid_rates_and_unknown_currency_never_default_to_gbp(rate: str) -> None:
    assert resolve_fx("USD", EVENT, broker_rate_native_per_gbp=Decimal(rate)) is None
    assert resolve_fx("", EVENT) is None
    assert resolve_fx("USD", EVENT) is None


def test_cached_daily_rates_are_available_only_after_their_close_date(tmp_path) -> None:
    calls = []

    def history(symbol, start, end):
        calls.append((symbol, start, end))
        return pd.DataFrame(
            {"Close": [1.25, 1.2]}, index=pd.to_datetime(["2026-01-02", "2026-01-05"])
        )

    resolver = HistoricalFxResolver(tmp_path, history_loader=history)
    monday = resolve_fx("USD", datetime(2026, 1, 5, 12, tzinfo=UTC), resolver=resolver)
    tuesday = resolve_fx("USD", EVENT, resolver=resolver)
    assert monday.native_per_gbp == Decimal("1.25")
    assert monday.observed_at == datetime(2026, 1, 3, tzinfo=UTC)
    assert tuesday.native_per_gbp == Decimal("1.2")
    assert tuesday.source == "yahoo-daily-close:GBPUSD=X"
    assert len(calls) == 1

    def offline(*_args):
        raise AssertionError("the previously fetched quotes should be reusable")

    again = HistoricalFxResolver(tmp_path, history_loader=offline)
    assert resolve_fx("USD", EVENT, resolver=again) == tuesday
    assert resolve_fx("USD", datetime(2026, 2, 1, tzinfo=UTC), resolver=again) is None


def test_provider_failure_is_local_unavailability(tmp_path) -> None:
    def unavailable(*_args):
        raise RuntimeError("synthetic provider unavailable")

    assert (
        resolve_fx(
            "EUR", EVENT, resolver=HistoricalFxResolver(tmp_path, history_loader=unavailable)
        )
        is None
    )
    assert list(tmp_path.iterdir()) == []


def test_incomplete_daily_candle_cannot_become_evidence_after_offline_restart(
    tmp_path, monkeypatch
):
    class Clock(datetime):
        current = datetime(2026, 1, 6, 12, tzinfo=UTC)

        @classmethod
        def now(cls, tz=None):
            return cls.current.astimezone(tz)

    monkeypatch.setattr(fx_module, "datetime", Clock)

    def history(*_args):
        return pd.DataFrame(
            {"Close": [1.25, 9]}, index=pd.to_datetime(["2026-01-05", "2026-01-06"])
        )

    # Query the resolver directly: replacing the module clock deliberately
    # changes datetime identity but not the helper's chronological behavior.
    resolver = HistoricalFxResolver(tmp_path, history_loader=history)
    assert resolver("USD", Clock.current).native_per_gbp == Decimal("1.25")
    cached = json.loads(next(tmp_path.glob("*.json")).read_text())
    assert len(cached["quotes"]) == 1
    Clock.current = datetime(2026, 1, 7, 12, tzinfo=UTC)

    def offline(*_args):
        raise RuntimeError("synthetic outage")

    restarted = HistoricalFxResolver(tmp_path, history_loader=offline)
    quote = restarted("USD", Clock.current)
    assert quote.native_per_gbp == Decimal("1.25")
    assert quote.observed_at == datetime(2026, 1, 6, tzinfo=UTC)
    # A long-running worker also refreshes after the UTC day changes; it does
    # not require a process restart to acquire the newly completed close.
    updated = resolver("USD", Clock.current)
    assert updated.native_per_gbp == 9
    assert updated.observed_at == datetime(2026, 1, 7, tzinfo=UTC)


@pytest.mark.parametrize("content", ["[]", "null", "42"])
def test_malformed_cache_is_local_unavailability(tmp_path, content):
    (tmp_path / "historical-fx-v1-USD-2026.json").write_text(content)
    resolver = HistoricalFxResolver(tmp_path, history_loader=lambda *_args: pd.DataFrame())
    assert resolve_fx("USD", EVENT, resolver=resolver) is None
