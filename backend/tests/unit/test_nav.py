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
