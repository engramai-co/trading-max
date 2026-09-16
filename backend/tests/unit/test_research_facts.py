from datetime import date

import pandas as pd
import pytest
from trading_max.research.facts import build_financial_facts, make_quote
from trading_max.research.technical import (
    _clean_contracts,
    _completed_month_returns,
    _expiry_summary,
)


def statements(capex=-5.0):
    ends = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]

    def row(name, values):
        return {"index": name, **dict(zip(ends, values, strict=True))}

    return {
        "incomeStatement": [{"index": "Total Revenue", "2025-09-30": 350}],
        "quarterlyIncomeStatement": [
            row("Total Revenue", [80, 90, 100, 110, 120]),
            row("Net Income", [8, 9, 10, 11, 12]),
            row("Operating Income", [16, 18, 20, 22, 24]),
        ],
        "quarterlyCashflow": [
            row("Operating Cash Flow", [20, 21, 22, 23, 24]),
            row("Capital Expenditure", [capex] * 5),
        ],
        "quarterlyBalanceSheet": [
            row("Total Assets", [100, 110, 120, 130, 140]),
            row("Stockholders Equity", [50, 51, 52, 53, 54]),
        ],
    }


def observation(facts, metric, period=None):
    return next(
        o
        for o in facts.observations
        if o.metric == metric and o.period_id == (period or facts.latest_ttm)
    )


@pytest.mark.parametrize("capex", [-5, 5])
def test_ttm_is_reconcilable_and_does_not_mix_summary_values(capex):
    facts = build_financial_facts(
        statements(capex),
        {"financialCurrency": "USD", "freeCashflow": 61, "operatingMargins": 0.15},
    )
    assert observation(facts, "revenue").value == 420
    assert observation(facts, "freeCashflow").value == 70
    assert observation(facts, "operatingMargin").value == pytest.approx(0.2)
    assert observation(facts, "roa").value == pytest.approx(42 / 120)
    assert facts.reconciliation["difference"] == 9
    assert len(observation(facts, "freeCashflow").evidence) == 8
    q3 = next(p for p in facts.periods if p.id == "quarterly:2026-06-30")
    assert q3.label == "Q3 FY2026"
    assert q3.actual_end is None
    assert observation(facts, "revenueGrowth", q3.id).value == 0.5


def test_missing_quarter_and_conflicting_duplicates_never_become_zero():
    raw = statements()
    raw["quarterlyCashflow"][0]["2026-03-31"] = None
    facts = build_financial_facts(raw, {"financialCurrency": "USD"})
    assert observation(facts, "freeCashflow").value is None
    raw["quarterlyIncomeStatement"].append({"index": "Total Revenue", "2026-06-30": 999})
    facts = build_financial_facts(raw, {})
    assert observation(facts, "revenue", "quarterly:2026-06-30").state == "invalid"


def test_gap_in_quarters_does_not_produce_ttm():
    raw = statements()
    for rows in raw.values():
        for row in rows:
            row.pop("2026-03-31", None)
    assert build_financial_facts(raw, {}).latest_ttm is None


def test_reported_52_week_period_preserves_provider_key():
    facts = build_financial_facts(
        statements(),
        {},
        period_evidence=[
            {
                "providerEnd": "2025-09-30",
                "kind": "annual",
                "actualEnd": "2025-09-27",
                "actualStart": "2024-09-29",
                "fiscalYear": 2025,
            }
        ],
    )
    annual = next(p for p in facts.periods if p.kind == "annual")
    assert annual.actual_end == "2025-09-27"
    assert annual.provider_end == "2025-09-30"
    assert annual.identity_status == "reported"


def test_quote_keeps_currency_unknown_and_converts_only_pence_baseline():
    assert make_quote("X", {"price": 10}, {}).currency is None
    quote = make_quote(
        "X.L", {"price": 10}, {"currency": "GBp", "metrics": {"regularMarketPreviousClose": 900}}
    )
    assert quote.currency == "GBP"
    assert quote.change == 1


def test_semiannual_disclosure_is_not_counted_as_a_quarter():
    facts = build_financial_facts(
        statements(),
        {},
        period_evidence=[
            {
                "providerEnd": "2026-03-31",
                "providerKind": "quarterly",
                "kind": "semiannual",
                "actualStart": "2025-10-01",
                "actualEnd": "2026-03-31",
                "fiscalYear": 2026,
            }
        ],
    )
    half = next(p for p in facts.periods if p.kind == "semiannual")
    assert half.label == "H1 FY2026"
    assert half.fiscal_half == 1
    assert facts.latest_ttm is None


def test_seasonality_drops_partial_month_and_does_not_bridge_missing_months():
    series = pd.Series(
        [100, 110, 120, 90, 999],
        index=pd.to_datetime(
            ["2026-01-30", "2026-02-27", "2026-04-30", "2026-05-29", "2026-06-10"]
        ),
    )
    result = _completed_month_returns(series, as_of=date(2026, 6, 12))
    assert list(result.index.month) == [2, 5]
    assert list(result) == pytest.approx([0.1, -0.25])


def test_option_missing_oi_is_preserved_and_not_used_as_zero():
    frame = pd.DataFrame(
        {
            "strike": [100, 110],
            "lastPrice": [2, 1],
            "bid": [1, 0],
            "ask": [3, 2],
            "openInterest": [None, 0],
            "volume": [None, 0],
            "impliedVolatility": [0.3, 0.3],
        }
    )
    clean = _clean_contracts(frame, "call", date(2099, 1, 1))
    assert len(clean) == 2
    assert pd.isna(clean.iloc[0].open_interest)
    assert clean.iloc[1].open_interest == 0
    summary = _expiry_summary(clean, "2099-01-01", 100)
    assert summary["call_open_interest"] is None
    assert summary["open_interest_coverage"] == 1
