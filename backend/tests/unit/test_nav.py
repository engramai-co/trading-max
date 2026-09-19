from __future__ import annotations

import csv
import io

import pytest
from trading_max.analytics.nav import append_valuation

HEADER = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
)


def test_append_valuation_calculates_return_without_inventing_flow() -> None:
    text = HEADER + "2026-08-01,10,90,100,0,0,,,\n"

    result = append_valuation(
        text,
        date="2026-08-02",
        value=110,
        cash=12,
        invested=98,
    )
    rows = list(csv.DictReader(io.StringIO(result.decode())))

    assert len(rows) == 2
    assert rows[-1]["ExternalFlowGBP"] == "0.00000000"
    assert float(rows[-1]["DailyReturn"]) == pytest.approx(0.1)
    assert float(rows[-1]["TWRWealth"]) == pytest.approx(1.1)
    assert float(rows[-1]["Drawdown"]) == pytest.approx(0.0)


def test_append_valuation_replaces_same_day_and_keeps_history() -> None:
    text = HEADER + "2026-08-01,10,90,100,0,0,,,\n" + "2026-08-02,10,95,105,0,0,0.05,1.05,0\n"

    result = append_valuation(text, date="2026-08-02", value=103)
    rows = list(csv.DictReader(io.StringIO(result.decode())))

    assert [row["Date"] for row in rows] == ["2026-08-01", "2026-08-02"]
    assert rows[-1]["SyntheticNAVGBP"] == "103.00000000"
    assert float(rows[-1]["DailyReturn"]) == pytest.approx(0.03)


def test_append_valuation_rejects_nonpositive_nav() -> None:
    with pytest.raises(ValueError, match="positive"):
        append_valuation(HEADER, date="2026-08-02", value=0)


def test_same_day_refresh_preserves_reconciled_flows_and_broker_provenance() -> None:
    header = HEADER.rstrip("\n") + ",ValuationSource,PerformanceStatus\n"
    text = (
        header
        + "2026-08-01,10,90,100,100,50,,,,broker_native,eligible\n"
        + "2026-08-02,110,100,210,100,50,0.066666666667,1.066666666667,0,broker_native,eligible\n"
    )
    result = append_valuation(text, date="2026-08-02", value=212, cash=110, invested=102)
    rows = list(csv.DictReader(io.StringIO(result.decode())))
    assert sum(float(row["ExternalFlowGBP"]) for row in rows) == 200
    assert float(rows[-1]["WeightedExternalFlowGBP"]) == 50
    assert float(rows[-1]["DailyReturn"]) == pytest.approx(12 / 150)
    assert float(rows[-1]["TWRWealth"]) == pytest.approx(1.08)
    assert rows[-1]["ValuationSource"] == "broker_native"
    assert rows[-1]["PerformanceStatus"] == "eligible"


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_append_valuation_rejects_nonfinite_nav(value: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        append_valuation(HEADER, date="2026-08-02", value=value)


def test_same_day_observation_reweights_reconciled_flows_for_longer_interval() -> None:
    header = HEADER.rstrip("\n") + ",ValuationSource,PerformanceStatus,ObservedAt\n"
    text = (
        header
        + "2026-08-01,10,90,100,100,50,,,,broker_native,eligible,2026-08-01T20:00:00Z\n"
        + "2026-08-02,110,100,210,100,50,0.066666666667,1.066666666667,0,broker_native,eligible,2026-08-02T12:00:00Z\n"
    )
    result = append_valuation(
        text,
        date="2026-08-02",
        value=212,
        cash=110,
        invested=102,
        observed_at="2026-08-02T20:00:00Z",
    )
    row = list(csv.DictReader(io.StringIO(result.decode())))[-1]
    assert float(row["WeightedExternalFlowGBP"]) == pytest.approx(100 * 16 / 24)
    assert float(row["DailyReturn"]) == pytest.approx(12 / (100 + 100 * 16 / 24))
    assert row["ObservedAt"] == "2026-08-02T20:00:00+00:00"


def test_appending_to_ineligible_history_keeps_performance_suppressed() -> None:
    header = HEADER.rstrip("\n") + ",ValuationSource,PerformanceStatus\n"
    text = (
        header + "2026-08-01,10,90,100,100,50,,,,broker_native,unverified_broker_observation_time\n"
    )
    result = append_valuation(text, date="2026-08-02", value=103)
    row = list(csv.DictReader(io.StringIO(result.decode())))[-1]
    assert row["DailyReturn"] == row["TWRWealth"] == row["Drawdown"] == ""
    assert row["PerformanceStatus"] == "unverified_broker_observation_time"
