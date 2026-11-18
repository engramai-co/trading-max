import pytest
from trading_max.research.facts import build_financial_facts
from trading_max.research.listing import quote_listing
from trading_max.research.statement_valuation import freeze_basis
from trading_max.research.valuation_basis import classify

ENDS = ["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]


@pytest.mark.parametrize("missing", ["Total Revenue", "Operating Cash Flow"])
def test_choose_last_complete_rolling_period_then_fiscal_year(missing):
    def line(name, value):
        return {"index": name, **dict.fromkeys(ENDS[:-1] if name == missing else ENDS, value)}

    raw = {
        "quarterlyIncomeStatement": [line("Total Revenue", 100)],
        "quarterlyCashflow": [line("Operating Cash Flow", 20), line("Capital Expenditure", -4)],
        "incomeStatement": [{"index": "Total Revenue", "2024-12-31": 200}],
        "cashflow": [
            {"index": "Operating Cash Flow", "2024-12-31": 40},
            {"index": "Capital Expenditure", "2024-12-31": -20},
        ],
    }

    def freeze():
        return freeze_basis(
            build_financial_facts(raw, {"financialCurrency": "EUR"}),
            "cash-flow",
            ticker="SYN",
            spot=10,
            currency="GBP",
            shares=100,
            fx=0.8,
            quote_id="q",
            listing=None,
        )

    basis = freeze()
    assert (basis.period_id, basis.revenue, basis.start_margin) == ("ttm:2025-09-30", 320, 0.16)
    del raw["quarterlyCashflow"][0][ENDS[1]]
    basis = freeze()
    assert (basis.period_id, basis.revenue, basis.start_margin) == ("annual:2024-12-31", 160, 0.1)


@pytest.mark.parametrize(
    ("suffix", "zone", "market"),
    [
        (".HK", "Asia/Hong_Kong", "XHKG"),
        (".T", "Asia/Tokyo", "XTKS"),
        (".KS", "Asia/Seoul", "XKRX"),
        (".PA", "Europe/Paris", "XPAR"),
    ],
)
def test_exact_research_listing(suffix, zone, market):
    assert quote_listing("SYN" + suffix, None, zone) == market + ":SYN" + suffix


def test_verified_receipt_uses_ordinary_statement_shares_once():
    raw = {
        "incomeStatement": [{"index": "Total Revenue", "2025-12-31": 100}],
        "cashflow": [
            {"index": "Operating Cash Flow", "2025-12-31": 25},
            {"index": "Capital Expenditure", "2025-12-31": -5},
        ],
        "balanceSheet": [{"index": "Ordinary Shares Number", "2025-12-31": 500}],
    }
    kwargs = {
        "ticker": "TSM",
        "spot": 20,
        "currency": "USD",
        "shares": 100,
        "fx": 0.03,
        "quote_id": "q",
        "listing": "US:TSM",
    }
    facts = build_financial_facts(raw, {"financialCurrency": "TWD"})
    b = freeze_basis(facts, "cash-flow", **kwargs)
    assert (b.shares, b.ordinary_per_receipt, b.revenue, b.start_margin) == (100, 5, 3, 0.2)
    with pytest.raises(ValueError, match="currency-conversion"):
        freeze_basis(facts, "cash-flow", **(kwargs | {"fx": None}))
    with pytest.raises(ValueError, match="share-count"):
        freeze_basis(
            facts, "cash-flow", **(kwargs | {"ticker": "SYN", "listing": "US:SYN", "is_adr": True})
        )


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("40101010", "residual-income"),
        ("40301020", "residual-income"),
        ("40301010", "cash-flow"),
        ("40203020", "net-income"),
        ("40203040", "cash-flow"),
        ("40203010", "cash-flow"),
        ("40201060", "cash-flow"),
    ],
)
def test_gics_and_disclosed_statement_fallback(code, expected):
    raw = {"balanceSheet": [{"index": "Total Deposits", "2025-12-31": 100}]}
    assert classify("SYN", code, raw) == (expected, "gics-" + code)
    assert classify("SYN", "", raw) == ("residual-income", "statement-structure")
    assert classify("IREN", "40101010", raw) == ("cash-flow", "reviewed-listing")
