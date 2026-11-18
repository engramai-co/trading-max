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
            listing="US:SYN",
            ordinary_listing=True,
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


@pytest.mark.parametrize(
    ("ticker", "bank", "broker"),
    [
        ("JPM", True, False),
        ("BAC", True, False),
        ("IBKR", False, True),
        ("V", False, False),
        ("MA", False, False),
        ("CME", False, False),
    ],
)
def test_adapter_rows_without_gics(ticker, bank, broker):
    # Yahoo's generalised statements use these labels across financial companies.
    income = ["Interest Expense", "Net Interest Income", "Net Income Common Stockholders"]
    balance = ["Common Stock Equity", "Accounts Receivable"]
    if bank:
        balance += ["Cash Cash Equivalents And Federal Funds Sold"]
        income += ["Other Non Interest Expense"]
    else:
        balance += ["Restricted Cash"]
        income += ["Net Non Operating Interest Income Expense"]
    if broker:
        balance += ["Loans Receivable"]

    def rows(fields):
        return [{"index": field, "2025-12-31": 100} for field in fields]

    assert classify(ticker, "", {"incomeStatement": rows(income), "balanceSheet": rows(balance)})[
        0
    ] == ("residual-income" if bank else "net-income" if broker else "cash-flow")


def test_unmarked_ads_uses_verified_listing_ratio_and_ambiguous_counts_are_withheld():
    from trading_max.research.valuation_basis import listing_shares

    facts = build_financial_facts(
        {"balanceSheet": [{"index": "Ordinary Shares Number", "2025-12-31": 800}]}, {}
    )
    observations = {o.metric: o for o in facts.observations}
    for vendor_count in (100, 800):
        assert listing_shares(
            "BABA", "US:BABA", "Alibaba Group Holding Limited", vendor_count, observations
        ) == (100, 8)
    assert listing_shares("BABA", "US:BABA", "Alibaba Group Holding Limited", 800, {})[0] is None
    for listing in ("US:SYN", None):
        assert (
            listing_shares("SYN", listing, "Synthetic Group Limited", 800, observations)[0] is None
        )


def test_burn_without_closing_cash_falls_back_to_usable_fiscal_year():
    def q(field, value):
        return {"index": field, **dict.fromkeys(ENDS[1:], value)}

    def y(field, value):
        return {"index": field, ENDS[0]: value}

    facts = build_financial_facts(
        {
            "quarterlyIncomeStatement": [q("Total Revenue", 50)],
            "quarterlyCashflow": [q("Operating Cash Flow", -10), q("Capital Expenditure", -5)],
            "incomeStatement": [y("Total Revenue", 100)],
            "cashflow": [y("Operating Cash Flow", 20), y("Capital Expenditure", -5)],
        },
        {},
    )
    from trading_max.research.valuation_basis import statement_basis

    assert statement_basis(facts, "cash-flow")[0].id == "annual:2024-12-31"


def test_residual_income_does_not_require_a_revenue_observation():
    from trading_max.research.fundamentals import _sector_profile
    from trading_max.research.statement_valuation import scenario_defaults
    from trading_max.research.valuation_preview import ValuationPreviewRequest, preview

    facts = build_financial_facts(
        {
            "incomeStatement": [{"index": "Net Income Common Stockholders", "2025-12-31": 30}],
            "balanceSheet": [
                {"index": "Common Stock Equity", "2025-12-31": 200},
                {"index": "Ordinary Shares Number", "2025-12-31": 100},
            ],
        },
        {"financialCurrency": "USD"},
    )
    basis = freeze_basis(
        facts,
        "residual-income",
        ticker="ARM",
        listing="US:ARM",
        currency="USD",
        spot=12,
        shares=100,
        fx=1,
        quote_id="q",
    )
    assert basis.revenue is None
    defaults, refs = scenario_defaults(basis, facts, _sector_profile("", "")[0], 0.1)
    assert defaults["base"].initial_roe == pytest.approx(0.15) and not refs
    assert preview(basis, ValuationPreviewRequest(scenarios=defaults)).scenarios["base"].value > 0


def test_receipt_chooses_a_period_with_reported_ordinary_shares():
    def row(field, quarters, value):
        return {"index": field, **dict.fromkeys(quarters, value)}

    raw = {
        "quarterlyIncomeStatement": [row("Total Revenue", ENDS[1:], 100)],
        "quarterlyCashflow": [
            row("Operating Cash Flow", ENDS[1:], 20),
            row("Capital Expenditure", ENDS[1:], -2),
        ],
        "incomeStatement": [row("Total Revenue", ENDS[:1], 300)],
        "cashflow": [
            row("Operating Cash Flow", ENDS[:1], 60),
            row("Capital Expenditure", ENDS[:1], -6),
        ],
        "balanceSheet": [row("Ordinary Shares Number", ENDS[:1], 800)],
    }
    b = freeze_basis(
        build_financial_facts(raw, {"financialCurrency": "USD"}),
        "cash-flow",
        ticker="BABA",
        listing="US:BABA",
        currency="USD",
        shares=800,
        spot=2,
        fx=1,
        quote_id="q",
    )
    assert (b.period_id, b.shares) == ("annual:2024-12-31", 100)


@pytest.mark.parametrize(
    ("filed_listing", "unit", "eligible"),
    [
        ("US:SYN", "ordinary", True),
        ("US:SYN", "receipt", False),
        ("US:SYN", "unknown", False),
        ("LSE:SYN", "ordinary", False),
    ],
)
def test_batch_requires_share_unit_evidence_for_the_quote(filed_listing, unit, eligible):
    from trading_max.research.fundamentals import build_valuation

    raw = {
        "incomeStatement": [{"index": "Total Revenue", ENDS[-1]: 100}],
        "cashflow": [
            {"index": "Operating Cash Flow", ENDS[-1]: 25},
            {"index": "Capital Expenditure", ENDS[-1]: -5},
        ],
        "evidence": {
            "listedShareUnits": {filed_listing: unit},
            "shareUnitFiling": "https://issuer.invalid/cover",
        },
    }
    result = build_valuation(
        {"tickers": ["SYN"], "rows": [{"ticker": "SYN", "price": 10, "currency": "USD"}]},
        {
            "rows": [
                {
                    "ticker": "SYN",
                    "name": "Synthetic Group Limited",
                    "currency": "USD",
                    "metrics": {
                        "fullExchangeName": "NYSE",
                        "financialCurrency": "USD",
                        "sharesOutstanding": 100,
                        "quoteType": "EQUITY",
                    },
                }
            ]
        },
        financials={"rows": [{"ticker": "SYN", "financials": raw}]},
    )
    row = result.rows[0]
    assert (row["ev5"] is not None) == eligible
    if eligible:
        assert row["assumptions"]["shareUnit"] == "ordinary"
        assert row["assumptions"]["shareUnitFiling"] == "https://issuer.invalid/cover"
    elif unit == "receipt":
        assert row["model_warnings"] == ["complete-ttm-currency-and-share-count-required"]
    else:
        assert row["model_warnings"] == ["listed-share-unit-unverified"]


def test_class_count_requires_a_period_with_company_wide_shares():
    from trading_max.research.valuation_basis import statement_basis

    ends = ENDS[1:]
    raw = {
        "quarterlyIncomeStatement": [{"index": "Total Revenue", **dict.fromkeys(ends, 100)}],
        "quarterlyCashflow": [
            {"index": field, **dict.fromkeys(ends, amount)}
            for field, amount in [("Operating Cash Flow", 20), ("Capital Expenditure", -5)]
        ],
        "incomeStatement": [{"index": "Total Revenue", ENDS[0]: 300}],
        "cashflow": [
            {"index": field, ENDS[0]: amount}
            for field, amount in [("Operating Cash Flow", 60), ("Capital Expenditure", -15)]
        ],
    }

    def period():
        return statement_basis(build_financial_facts(raw, {}), "cash-flow", "XCSE:NOVO-B.CO")[0]

    assert period() is None
    raw["balanceSheet"] = [{"index": "Ordinary Shares Number", ENDS[0]: 4400}]
    assert period().id == "annual:2024-12-31"


def test_ordinary_designation_cannot_establish_equivalent_distribution_rights():
    from trading_max.research.valuation_basis import share_unit

    assert share_unit("XCSE:SYN-B.CO", {}, "Common Stock") is None
    assert share_unit("US:SYN", {"US:SYN": "ordinary", "US:SYNX": "ordinary"}) is None
    assert share_unit("XCSE:NOVO-B.CO", {"XCSE:NOVO-B.CO": "receipt"}) == "receipt"


def test_catalog_listing_type_preserves_local_symbol_and_withholds_ambiguous_entities():
    from trading_max.reference import CatalogSecurityMaster, SecurityMasterCatalog
    from trading_max.reference.security_master import SecurityDescriptor

    def lookup(listings, *, ticker="SHEL.L", exchange="London", canonical="SHEL"):
        record = {
            "entityId": "synthetic",
            "canonicalTicker": canonical,
            "entityName": "Synthetic",
            "providerSecurityType": "Common Stock",
            "source": "synthetic",
            "listings": [{**item, "source": "synthetic"} for item in listings],
        }
        catalog = CatalogSecurityMaster(SecurityMasterCatalog.model_validate({"records": [record]}))
        return catalog.listing_security_type(SecurityDescriptor(ticker=ticker, exchange=exchange))

    london = {"ticker": "SHEL", "mic": "XLON"}
    nyse = {"ticker": "SHEL", "exchange": "NYSE"}
    assert "Common Stock" in lookup([london])
    assert quote_listing("001002.KQ", "KSC", "Asia/Seoul") is None
    assert quote_listing("001001.KS", "KOSDAQ", "Asia/Seoul") is None
    assert quote_listing("SYN.DE", "Frankfurt", "Europe/Berlin") is None
    assert not lookup([london], ticker="SHEL", exchange="NYSE")
    assert not lookup([london, nyse], ticker="SHEL", exchange="NYSE")
    assert not lookup(
        [{"ticker": "SHEL", "exchange": "London", "mic": "XNYS"}], ticker="SHEL", exchange="NYSE"
    )
