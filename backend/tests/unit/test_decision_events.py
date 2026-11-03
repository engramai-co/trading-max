from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest
from trading_max.analytics.decision_events import (
    CachedSecurityEvents,
    attach_decision_events,
    shown_decisions,
)
from trading_max.analytics.decision_prices import SecurityPrices
from trading_max.analytics.decision_review import build_decision_review
from trading_max.analytics.historical_nav import _trade_columns


def _closes(start: str, values: list[float]) -> pd.Series:
    return pd.Series(values, index=pd.bdate_range(start, periods=len(values)), dtype=float)


def _fill(time: str, action: str, shares: float, total_gbp: float) -> dict:
    return {
        "Time": pd.Timestamp(time, tz="UTC"),
        "Action": action,
        "Ticker": "NVDA",
        "Name": "NVDA Inc",
        "ISIN": "US0000000001",
        "Shares": shares,
        "TotalN": total_gbp,
        "TotalGBP": total_gbp,
        "Price / share": total_gbp / shares,
        "Exchange rate": 1.0,
        "Currency (Price / share)": "GBP",
        "Currency (Total)": "GBP",
    }


def test_events_are_cached_and_kept_through_a_provider_outage(tmp_path) -> None:
    calls: list[str] = []
    state = {"fail": False}

    def fetch(symbol: str):
        calls.append(symbol)
        if state["fail"]:
            raise RuntimeError("provider down")
        return [{"date": "2026-10-28", "kind": "earnings", "surprise_pct": 8.2}]

    clock = {"now": datetime(2026, 11, 3, 12, tzinfo=UTC)}
    events = CachedSecurityEvents(tmp_path, fetch=fetch, now=lambda: clock["now"])
    assert events("LITE")[0]["surprise_pct"] == 8.2
    assert events("LITE") and calls == ["LITE"]
    clock["now"] += timedelta(days=2)
    state["fail"] = True
    assert events("LITE")[0]["kind"] == "earnings"
    assert calls == ["LITE", "LITE"]


def test_shown_decisions_are_the_largest_effects_and_the_latest() -> None:
    rows = [
        {"side": "buy", "effect_horizon_gbp": float(value), "effect_to_date_gbp": None}
        for value in range(-10, 11)
    ] + [{"side": "sell", "effect_horizon_gbp": None, "effect_to_date_gbp": None}] * 20
    shown = shown_decisions(rows)
    # The five largest gains and losses among buys, plus the twelve latest rows.
    assert {0, 1, 2, 3, 4, 16, 17, 18, 19, 20} <= set(shown)
    assert set(range(len(rows) - 12, len(rows))) <= set(shown)
    assert 8 not in shown


def test_shown_decisions_carry_the_events_of_their_window() -> None:
    closes = _closes("2026-10-01", [100.0] * 40)
    review = {
        "horizon_days": 20,
        "decisions": [
            {
                "date": "2026-10-12",
                "ticker": "LITE",
                "side": "sell",
                "effect_horizon_gbp": -50.0,
                "effect_to_date_gbp": -40.0,
            }
        ],
    }
    catalog = [
        {"date": "2026-09-30", "kind": "filing", "form": "8-K"},  # before the 7-day lead
        {"date": "2026-10-06", "kind": "news", "title": "Guidance raised"},
        {"date": "2026-10-20", "kind": "downgrade", "firm": "B. Riley", "to_grade": "Neutral"},
        {"date": "2026-10-21", "kind": "earnings", "surprise_pct": 8.2},
        {"date": "2026-10-22", "kind": "filing", "form": "10-Q"},
        {"date": "2026-10-23", "kind": "initiate", "firm": "Citi"},
        {"date": "2026-12-01", "kind": "earnings", "surprise_pct": 1.0},  # after the window
    ]
    read = attach_decision_events(review, {"LITE": ("LITE", closes)}, lambda symbol: catalog)
    events = review["decisions"][0]["events"]
    assert read == 1
    # At most four: the most telling kinds are kept (the news drops), shown by date.
    assert [event["kind"] for event in events] == ["downgrade", "earnings", "filing", "initiate"]


def test_routine_filings_do_not_crowd_out_other_events() -> None:
    closes = _closes("2026-10-01", [100.0] * 40)
    review = {
        "horizon_days": 20,
        "decisions": [
            {"date": "2026-10-12", "ticker": "VRT", "side": "buy", "effect_to_date_gbp": -200.0}
        ],
    }
    catalog = [{"date": f"2026-10-{day}", "kind": "filing", "form": "8-K"} for day in (13, 15, 20)]
    catalog.append({"date": "2026-10-21", "kind": "initiate", "firm": "Bernstein"})
    attach_decision_events(review, {"VRT": ("VRT", closes)}, lambda symbol: catalog)
    kinds = [event["kind"] for event in review["decisions"][0]["events"]]
    assert kinds == ["filing", "initiate"]


def test_decisions_record_the_benchmarks_change_over_the_same_window() -> None:
    closes = _closes("2026-01-05", [100.0] * 5 + [120.0] * 30)
    market = _closes("2026-01-05", [400.0] * 5 + [440.0] * 30)
    trades = _trade_columns(pd.DataFrame([_fill("2026-01-05T15:00:00Z", "Market buy", 10, 1_000)]))
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {identity: SecurityPrices(identity, "NVDA", "NVDA Inc", "NVDA", closes)},
        as_of=closes.index[-1],
        market=market,
    )
    (buy,) = review["decisions"]
    assert buy["return_horizon"] == pytest.approx(0.2)
    assert buy["market_return_horizon"] == pytest.approx(0.1)
    assert buy["market_return_to_date"] == pytest.approx(0.1)
