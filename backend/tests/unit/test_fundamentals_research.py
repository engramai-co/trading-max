from __future__ import annotations

from datetime import UTC, datetime

import pytest
from trading_max.research.fundamentals import (
    ResearchDataError,
    YFinanceResearchService,
    build_valuation,
)


def test_yfinance_service_normalizes_fake_provider_data() -> None:
    service = YFinanceResearchService(
        info_loader=lambda ticker: {
            "longName": f"{ticker} Inc.",
            "currency": "USD",
            "forwardPE": 18.5,
            "marketCap": 1_000_000,
            "grossMargins": 0.42,
            "operatingCashflow": 125_000,
            "totalRevenue": 800_000,
        },
        calendar_loader=lambda ticker: {
            "Earnings Date": datetime(2026, 9, 1, tzinfo=UTC),
        },
    )

    fundamentals = service.fundamentals(["BE"], as_of="2026-08-07")
    earnings = service.earnings(["BE"], as_of="2026-08-07")

    assert fundamentals.rows[0]["metrics"]["forwardPE"] == 18.5
    assert fundamentals.rows[0]["metrics"]["grossMargins"] == 0.42
    assert fundamentals.rows[0]["metrics"]["operatingCashflow"] == 125_000
    assert fundamentals.rows[0]["metrics"]["totalRevenue"] == 800_000
    assert earnings.rows[0]["calendar"]["Earnings Date"] == "2026-09-01T00:00:00+00:00"


def test_valuation_is_transparent_when_forward_pe_is_missing() -> None:
    result = build_valuation(
        {"as_of": "2026-08-07", "tickers": ["BE"], "rows": [{"ticker": "BE", "price": 22.0}]},
        {
            "as_of": "2026-08-07",
            "rows": [{"ticker": "BE", "metrics": {"forwardPE": None}}],
            "warnings": [],
        },
    )

    assert result.rows[0]["verdict"] == "not-covered"
    assert result.rows[0]["lenses"]["forwardPE"] is None
    assert result.rows[0]["model_status"] == "unavailable"
    assert "missing total revenue" in result.rows[0]["model_warnings"]


def test_valuation_calculates_scenario_cashflow_lenses() -> None:
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["VRT"],
            "rows": [{"ticker": "VRT", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "VRT",
                    "currency": "USD",
                    "metrics": {
                        "forwardPE": 25.0,
                        "marketCap": 100_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 2_000_000_000,
                        "totalDebt": 1_500_000_000,
                        "totalCash": 500_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.15,
                        "targetMedianPrice": 125.0,
                    },
                }
            ],
            "warnings": [],
        },
    )

    row = result.rows[0]
    assert row["model_status"] == "indicative"
    assert any("levered FCF proxy" in warning for warning in row["model_warnings"])
    assert row["ev5"] > 0
    assert row["ev10"] > row["ev5"]
    assert -0.30 <= row["impl"] <= 0.80
    assert row["base_g"] == 0.15
    assert row["med"] == 125.0
    assert row["assumptions"]["freeCashflowMargin"] == 0.2
    assert row["source"] == "trading-max-valuation-v4"
    assert row["method"] == "levered-fcf-exit-scenarios"
    assert row["valuationPolicy"]["discountRateType"] == "cost-of-equity"
    assert row["valuationPolicy"]["analystTargetsAreReferenceOnly"] is True
    assert row["valueRange"]["bear"] <= row["valueRange"]["base"]
    assert row["valueRange"]["base"] <= row["valueRange"]["bull"]
    assert row["terminalCheck"]["gordonMultiple"] is not None
    assert len(row["sensitivity"]["discountRate"]["values"]) == 5
    assert len(row["sensitivity"]["revenueGrowth"]["values"]) == 5
    assert len(row["sensitivity"]["fcfMargin"]["values"]) == 5


def test_valuation_normalizes_cyclical_margin_spikes() -> None:
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["SOFT"],
            "rows": [{"ticker": "SOFT", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "SOFT",
                    "currency": "USD",
                    "sector": "Technology",
                    "industry": "Software—Infrastructure",
                    "metrics": {
                        "forwardPE": 30.0,
                        "marketCap": 50_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 4_000_000_000,
                        "totalDebt": 1_000_000_000,
                        "totalCash": 200_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.25,
                    },
                }
            ],
            "warnings": [],
        },
    )

    row = result.rows[0]
    assert row["method"] == "levered-fcf-exit-scenarios"
    assert row["assumptions"]["normalizedFcfMargin"] == 0.3
    assert any("normalized" in warning for warning in row["model_warnings"])


def test_valuation_refuses_to_invent_convergence_for_negative_fcf() -> None:
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["GROW"],
            "rows": [{"ticker": "GROW", "price": 50.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "GROW",
                    "currency": "USD",
                    "sector": "Technology",
                    "industry": "Software—Infrastructure",
                    "metrics": {
                        "forwardPE": 40.0,
                        "marketCap": 50_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": -1_000_000_000,
                        "totalDebt": 1_000_000_000,
                        "totalCash": 200_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.5,
                    },
                }
            ],
            "warnings": [],
        },
    )

    row = result.rows[0]
    assert row["method"] == "unavailable"
    assert row["model_status"] == "unavailable"
    assert row["ev5"] is None
    assert row["verdict"] == "not-covered"
    assert any("survival, financing" in warning for warning in row["model_warnings"])


def test_valuation_honours_legacy_manual_scenario_overrides() -> None:
    assumptions = {
        "companies": [
            {
                "ticker": "VRT",
                "scenarios": {
                    "base": {
                        "revenue_cagr": 0.30,
                        "target_fcf_margin": 0.30,
                        "discount_rate": 0.09,
                        "exit_fcf_multiple": 30.0,
                        "share_cagr": 0.02,
                    }
                },
            }
        ]
    }
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["VRT"],
            "rows": [{"ticker": "VRT", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "VRT",
                    "currency": "USD",
                    "sector": "Industrials",
                    "industry": "Electrical Equipment",
                    "metrics": {
                        "forwardPE": 25.0,
                        "marketCap": 100_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 2_000_000_000,
                        "totalDebt": 1_500_000_000,
                        "totalCash": 500_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.15,
                    },
                }
            ],
            "warnings": [],
        },
        assumptions=assumptions,
    )

    row = result.rows[0]
    assert row["assumptions"]["assumptionSource"] == "legacy-manual"
    assert row["scenarios"]["base"]["revenueCagr"] == 0.3
    assert row["scenarios"]["base"]["discountRate"] == 0.09
    assert row["scenarios"]["base"]["shareCagr"] == 0.02
    assert row["scenarios"]["base"]["exitFcfMultiple"] == 30.0
    assert row["scenarios"]["base"]["value"] > row["scenarios"]["base"]["gordonValue"]


def test_valuation_reads_camel_case_assumption_payloads() -> None:
    assumptions = {
        "companies": [
            {
                "ticker": "VRT",
                "scenarios": {
                    "base": {
                        "revenueCagr": 0.30,
                        "targetFcfMargin": 0.30,
                        "discountRate": 0.09,
                        "exitFcfMultiple": 30.0,
                        "shareCagr": 0.02,
                    }
                },
            }
        ]
    }
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["VRT"],
            "rows": [{"ticker": "VRT", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "VRT",
                    "currency": "USD",
                    "sector": "Industrials",
                    "industry": "Electrical Equipment",
                    "metrics": {
                        "forwardPE": 25.0,
                        "marketCap": 100_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 2_000_000_000,
                        "totalDebt": 1_500_000_000,
                        "totalCash": 500_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.15,
                    },
                }
            ],
            "warnings": [],
        },
        assumptions=assumptions,
    )

    row = result.rows[0]
    assert row["scenarios"]["base"]["revenueCagr"] == 0.3
    assert row["scenarios"]["base"]["discountRate"] == 0.09


def test_valuation_normalizes_report_currency_with_fx_loader() -> None:
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["EUCO"],
            "rows": [{"ticker": "EUCO", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "EUCO",
                    "currency": "USD",
                    "sector": "Technology",
                    "industry": "Software—Infrastructure",
                    "metrics": {
                        "financialCurrency": "EUR",
                        "forwardPE": 25.0,
                        "marketCap": 50_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 2_000_000_000,
                        "totalDebt": 1_000_000_000,
                        "totalCash": 200_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.2,
                    },
                }
            ],
            "warnings": [],
        },
        fx_loader=lambda report, quote: 1.1,
    )

    row = result.rows[0]
    assert row["assumptions"]["fxRate"] == 1.1
    assert row["assumptions"]["startingRevenue"] == pytest.approx(11_000_000_000)
    assert row["assumptions"]["netDebt"] == pytest.approx(880_000_000)


def test_valuation_keeps_analyst_range_as_reference_only() -> None:
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["FIN"],
            "rows": [{"ticker": "FIN", "price": 90.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "FIN",
                    "currency": "USD",
                    "sector": "Financial Services",
                    "metrics": {
                        "industry": "Capital Markets",
                        "forwardPE": 30.0,
                        "targetLowPrice": 80.0,
                        "targetMedianPrice": 100.0,
                        "targetHighPrice": 120.0,
                    },
                }
            ],
            "warnings": [],
        },
    )

    row = result.rows[0]
    assert row["method"] == "unavailable"
    assert row["model_status"] == "unavailable"
    assert row["valueRange"] == {}
    assert row["med"] == 100.0
    assert any("residual-income" in warning for warning in row["model_warnings"])


def test_valuation_flags_inconsistent_terminal_multiple() -> None:
    assumptions = {
        "companies": [
            {
                "ticker": "VRT",
                "scenarios": {
                    "base": {"exit_fcf_multiple": 40.0},
                },
            }
        ]
    }
    result = build_valuation(
        {
            "as_of": "2026-08-07",
            "tickers": ["VRT"],
            "rows": [{"ticker": "VRT", "price": 100.0}],
        },
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "VRT",
                    "currency": "USD",
                    "sector": "Industrials",
                    "industry": "Electrical Equipment",
                    "metrics": {
                        "marketCap": 100_000_000_000,
                        "totalRevenue": 10_000_000_000,
                        "freeCashflow": 2_000_000_000,
                        "totalDebt": 1_500_000_000,
                        "totalCash": 500_000_000,
                        "sharesOutstanding": 1_000_000_000,
                        "revenueGrowth": 0.15,
                    },
                }
            ],
            "warnings": [],
        },
        assumptions=assumptions,
    )

    row = result.rows[0]
    assert row["terminalCheck"]["consistent"] is False


def test_empty_provider_data_fails_loudly() -> None:
    service = YFinanceResearchService(
        info_loader=lambda ticker: {},
        calendar_loader=lambda ticker: {},
    )

    with pytest.raises(ResearchDataError):
        service.fundamentals([])
