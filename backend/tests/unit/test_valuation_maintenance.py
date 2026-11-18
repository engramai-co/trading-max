from datetime import UTC, date, datetime, timedelta

import pytest
from trading_max.research.estimate_history import ConsensusEstimate, EstimateObservation
from trading_max.research.facts import build_financial_facts
from trading_max.research.statement_valuation import freeze_basis
from trading_max.research.valuation_maintenance import (
    assumption_changes,
    eps_changes,
    figure_changes,
    fx_separable,
    restate,
    revenue_growth_changes,
    scenario_walk,
    source_conflicts,
)
from trading_max.research.valuation_preview import (
    LockedInput,
    ScenarioInputs,
    ValuationPreviewRequest,
    preview,
    project,
)

QUARTERS = ("2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31")
NEXT = "2026-03-31"
KEYS = ("bear", "base", "bull")
INPUTS = ScenarioInputs(
    revenue_cagr=0.08,
    target_fcf_margin=0.18,
    discount_rate=0.1,
    exit_fcf_multiple=15,
    share_cagr=0.0,
)


def statements(
    revenue,
    *,
    ocf=150.0,
    capex=-25.0,
    cash=500.0,
    shares=100.0,
    annual=None,
    currency="USD",
    duplicate=None,
    income=None,
    equity=None,
    net_income=None,
    annual_rows=(),
):
    ends = tuple(revenue)
    raw = {
        "quarterlyIncomeStatement": [{"index": "Total Revenue", **revenue}],
        "quarterlyCashflow": [
            {"index": "Operating Cash Flow", **dict.fromkeys(ends, ocf)},
            {"index": "Capital Expenditure", **dict.fromkeys(ends, capex)},
        ],
        "quarterlyBalanceSheet": [
            {
                "index": "Cash Cash Equivalents And Short Term Investments",
                **(cash if isinstance(cash, dict) else dict.fromkeys(ends, cash)),
            },
        ],
    }
    if shares is not None:
        raw["quarterlyBalanceSheet"].append(
            {"index": "Ordinary Shares Number", **dict.fromkeys(ends, shares)}
        )
    if income is not None:
        raw["quarterlyIncomeStatement"].append(
            {"index": "Net Income Common Stockholders", **dict.fromkeys(ends, income)}
        )
    if net_income is not None:
        raw["quarterlyIncomeStatement"].append(
            {"index": "Net Income", **dict.fromkeys(ends, net_income)}
        )
    if equity is not None:
        raw["quarterlyBalanceSheet"].append({"index": "Common Stock Equity", **equity})
    if annual:
        raw["incomeStatement"] = [{"index": "Total Revenue", **annual}]
    if annual_rows:
        raw.setdefault("incomeStatement", []).extend(annual_rows)
    if duplicate:
        raw["quarterlyIncomeStatement"].append({"index": "Total Revenue", **duplicate})
    return build_financial_facts(raw, {"financialCurrency": currency})


def quarters(value=1000.0, ends=QUARTERS, **changes):
    return {**dict.fromkeys(ends, value), **changes}


def basis(facts, *, spot=20.0, fx=None, family="cash-flow", quoted_shares=100):
    return freeze_basis(
        facts,
        family,
        ticker="TEST",
        spot=spot,
        currency="USD",
        shares=quoted_shares,
        fx=fx,
        quote_id=f"quote-{spot}",
        listing="US:TEST",
        ordinary_listing=True,
    )


def saved_model(frozen, horizon=5, inputs=INPUTS):
    return preview(
        frozen,
        ValuationPreviewRequest(
            family=frozen.family, horizon=horizon, scenarios=dict.fromkeys(KEYS, inputs)
        ),
    )


@pytest.mark.parametrize("horizon", [5, 10])
def test_walk_replays_the_saved_value_and_its_parts_add_up_to_the_proposal(horizon):
    old = basis(statements(quarters(), currency="EUR"), fx=1.10)
    newer = statements(quarters(ends=(*QUARTERS[1:], NEXT), **{NEXT: 1300.0}), currency="EUR")
    current = basis(newer, spot=26.0, fx=1.25)
    saved = saved_model(old, horizon)
    proposed = {
        **dict.fromkeys(KEYS, INPUTS),
        "base": INPUTS.model_copy(update={"revenue_cagr": 0.12}),
    }
    walk = scenario_walk(saved, current, proposed, horizon)
    desk = preview(
        current, ValuationPreviewRequest(family="cash-flow", horizon=horizon, scenarios=proposed)
    )
    for key, step in walk.items():
        assert step.saved == saved.scenarios[key].value
        assert step.proposal == desk.scenarios[key].value
        parts = step.statements_effect + step.price_fx_effect + step.assumptions_effect
        assert parts == pytest.approx(step.proposal - step.saved, rel=1e-12, abs=1e-12)
        assert step.restated is None and step.restatement_effect is None
    # The newest statements are valued at the saved spot and exchange rate first.
    rescaled = current.model_copy(
        update={
            "spot": 20.0,
            "spot_as_of": old.spot_as_of,
            "fx_rate": 1.10,
            "revenue": 4300 * 1.10,
            "opening_cash": 500 * 1.10,
        }
    )
    assert walk["base"].statements == pytest.approx(
        project(rescaled, INPUTS, horizon).value, rel=1e-12
    )
    assert walk["base"].price_fx == project(current, INPUTS, horizon).value
    assert walk["bear"].assumptions_effect == 0 and walk["base"].assumptions_effect > 0


def test_price_moves_a_value_only_through_financed_dilution():
    facts = statements(quarters())
    saved = saved_model(basis(facts))
    walk = scenario_walk(saved, basis(facts, spot=30.0), dict.fromkeys(KEYS, INPUTS), 5)
    assert walk["base"].statements_effect == 0
    assert walk["base"].price_fx_effect == 0
    burning = statements(quarters(), ocf=-300.0, cash=50.0)
    burn = INPUTS.model_copy(update={"target_fcf_margin": 0.1, "ramp_years": 4})
    saved = saved_model(basis(burning), inputs=burn)
    walk = scenario_walk(saved, basis(burning, spot=30.0), dict.fromkeys(KEYS, burn), 5)
    # A higher price issues fewer new shares for the same uncovered deficit.
    assert walk["base"].price_fx_effect > 0


def test_a_restated_saved_period_is_measured_on_its_own():
    saved = saved_model(basis(statements(quarters())))
    revised = statements(quarters(ends=(*QUARTERS, NEXT), **{QUARTERS[-1]: 850.0, NEXT: 1200.0}))
    restated, changes, check, gap, unchecked = restate(saved.basis, revised)
    assert (check, gap, unchecked) == ("restated", None, ())
    assert [(c.metric, c.saved, c.current, c.currency) for c in changes] == [
        ("revenue", 4000, 3850, "USD")
    ]
    assert restated.revenue == 3850 and restated.start_margin == pytest.approx(500 / 3850)
    assert (restated.period_id, restated.spot, restated.shares) == (
        saved.basis.period_id,
        saved.basis.spot,
        saved.basis.shares,
    )
    current = basis(revised)
    assert current.period_id == "ttm:2026-03-31"
    step = scenario_walk(saved, current, dict.fromkeys(KEYS, INPUTS), 5, restated)["base"]
    assert step.restated == project(restated, INPUTS, 5).value
    assert step.restatement_effect == step.restated - step.saved < 0
    assert step.statements_effect == step.statements - step.saved
    assert restate(saved.basis, statements(quarters())) == (None, [], "unchanged", None, ())


def test_restated_share_counts_need_a_balance_sheet_source():
    saved = saved_model(basis(statements(quarters(), shares=100.0)))
    restating = restate(saved.basis, statements(quarters(), shares=96.0))
    assert [(c.metric, c.saved, c.current, c.unit) for c in restating.changes] == [
        ("listingShares", 100, 96, "shares")
    ]
    assert restating.basis.shares == 96
    quoted = saved.basis.model_copy(update={"evidence": []})
    assert restate(quoted, statements(quarters(), shares=96.0)).check == "unchanged"


def test_a_quoted_share_count_stays_when_another_figure_is_restated():
    # Saved on a quoted count of 110. The statements now report 96 shares, and
    # restate revenue: only revenue is restated, so only revenue moves the value.
    saved = saved_model(basis(statements(quarters(), shares=None), quoted_shares=110))
    assert saved.basis.shares == 110
    revised = statements(quarters(**{QUARTERS[-1]: 850.0}), shares=96.0)
    restating = restate(saved.basis, revised)
    assert [(c.metric, c.saved, c.current) for c in restating.changes] == [("revenue", 4000, 3850)]
    assert restating.basis.shares == 110
    current = basis(revised)
    assert current.shares == 96
    step = scenario_walk(saved, current, dict.fromkeys(KEYS, INPUTS), 5, restating.basis)["base"]
    lower = saved.basis.model_copy(update={"revenue": 3850, "start_margin": 500 / 3850})
    assert step.restated == pytest.approx(project(lower, INPUTS, 5).value, rel=1e-12)
    assert step.restatement_effect < 0
    # The new denominator belongs to the new financial base, not to the restatement.
    assert step.statements == pytest.approx(
        project(current.model_copy(update={"spot": 20.0}), INPUTS, 5).value, rel=1e-12
    )


def test_a_saved_period_that_cannot_be_compared_says_why():
    saved = saved_model(basis(statements(quarters())))
    later = statements(quarters(ends=(*QUARTERS[2:], NEXT, "2026-06-30")))
    assert restate(saved.basis, later) == (None, [], "unavailable", "period-missing", ())
    assert restate(saved.basis, None).gap == "period-missing"
    euro = restate(saved.basis, statements(quarters(), currency="EUR"))
    assert (euro.check, euro.gap) == ("unavailable", "currency-changed")


def test_figures_still_reported_are_checked_when_another_is_missing():
    saved = saved_model(basis(statements(quarters())))
    # The current statements restate revenue and no longer report the period's cash.
    without_cash = dict.fromkeys(QUARTERS[:-1], 500.0)
    revised = statements(quarters(**{QUARTERS[-1]: 850.0}), cash=without_cash)
    restating = restate(saved.basis, revised)
    assert (restating.check, restating.gap, restating.unchecked) == (
        "restated",
        "metrics-incomplete",
        ("cash",),
    )
    assert [(c.metric, c.saved, c.current) for c in restating.changes] == [("revenue", 4000, 3850)]
    # The combined effect needs every figure the saved basis used, so it is withheld.
    assert restating.basis is None
    step = scenario_walk(saved, basis(revised), dict.fromkeys(KEYS, INPUTS), 5, None)["base"]
    assert step.restated is None and step.restatement_effect is None
    same = restate(saved.basis, statements(quarters(), cash=without_cash))
    assert same == (None, [], "unchanged", "metrics-incomplete", ("cash",))


def test_a_restated_book_moves_a_residual_income_value():
    equity = dict.fromkeys(QUARTERS, 2000.0)
    banked = basis(statements(quarters(), income=100.0, equity=equity), family="residual-income")
    roe = ScenarioInputs(initial_roe=0.2, payout=0.3, discount_rate=0.1, terminal_pb=1.2)
    saved = saved_model(banked, inputs=roe)
    revised = statements(quarters(), income=100.0, equity={**equity, QUARTERS[-1]: 1800.0})
    restating = restate(saved.basis, revised)
    assert [c.metric for c in restating.changes] == ["commonEquity"]
    assert restating.basis.book_per_share == pytest.approx(18)
    current = basis(revised, family="residual-income")
    step = scenario_walk(saved, current, dict.fromkeys(KEYS, roe), 5, restating.basis)["base"]
    # The period is unchanged, so the whole change in the base is the restatement.
    assert step.restatement_effect < 0
    assert step.restatement_effect == pytest.approx(step.statements_effect)


def test_quarters_and_fiscal_year_disagreements_are_disclosed_not_blended():
    facts = statements(quarters(), annual={"2025-12-31": 4100.0})
    frozen = basis(facts)
    assert frozen.revenue == 4000
    [conflict] = source_conflicts(facts, "cash-flow", frozen.period_id)
    assert (conflict.kind, conflict.metric, conflict.quarters, conflict.fiscal_year) == (
        "quarters-vs-fiscal-year",
        "revenue",
        4000,
        4100,
    )
    near = statements(quarters(), annual={"2025-12-31": 4010.0})
    assert source_conflicts(near, "cash-flow", basis(near).period_id) == []


def test_net_income_is_compared_when_common_earnings_are_not_reported():
    facts = statements(
        quarters(),
        net_income=100.0,
        annual_rows=[{"index": "Net Income", "2025-12-31": 500.0}],
    )
    frozen = basis(facts, family="net-income")
    assert frozen.period_id == "ttm:2025-12-31" and frozen.start_margin == pytest.approx(0.1)
    conflicts = source_conflicts(facts, "net-income", frozen.period_id)
    assert [(c.kind, c.metric, c.quarters, c.fiscal_year) for c in conflicts] == [
        ("quarters-vs-fiscal-year", "netIncome", 400, 500)
    ]


def test_conflicting_rows_in_the_compared_fiscal_year_are_disclosed():
    facts = statements(
        quarters(),
        annual={"2025-12-31": 4100.0},
        annual_rows=[{"index": "Total Revenue", "2025-12-31": 4200.0}],
    )
    frozen = basis(facts)
    assert frozen.period_id == "ttm:2025-12-31"
    conflicts = source_conflicts(facts, "cash-flow", frozen.period_id)
    # The fiscal year has two revenue rows, so the four quarters cannot be checked against it.
    assert [(c.kind, c.period_id, c.metric, c.blocks_comparison) for c in conflicts] == [
        ("conflicting-source-rows", "annual:2025-12-31", "revenue", True)
    ]


def test_conflicting_rows_in_a_newer_quarter_are_disclosed():
    facts = statements(quarters(ends=(*QUARTERS, NEXT)), duplicate={NEXT: 1100.0})
    frozen = basis(facts)
    assert frozen.period_id == "ttm:2025-12-31"
    assert [
        (c.kind, c.period_id, c.metric, c.blocks_comparison)
        for c in source_conflicts(facts, "cash-flow", frozen.period_id)
    ] == [("conflicting-source-rows", "quarterly:2026-03-31", "revenue", False)]


def test_consensus_changes_compare_the_same_fiscal_year_and_currency():
    at = datetime(2026, 1, 5, tzinfo=UTC)

    def observed(when, *rows):
        return EstimateObservation(
            ticker="TEST",
            listing="US:TEST",
            observed_at=when,
            consensus=[
                ConsensusEstimate(period=slot, period_end=end, currency=ccy, mean_eps=eps)
                for slot, end, ccy, eps in rows
            ],
        )

    saved = observed(
        at,
        ("0y", date(2025, 12, 31), "USD", 2.0),
        ("+1y", date(2026, 12, 31), "USD", 2.4),
        ("0q", date(2026, 3, 31), "USD", 0.5),
    )
    later = observed(
        at + timedelta(days=90),
        ("0y", date(2026, 12, 31), "USD", 2.6),
        ("+1y", date(2027, 12, 31), "USD", 3.0),
        ("0q", date(2026, 3, 31), "USD", 0.7),
    )
    [change] = eps_changes(saved, later)
    assert (change.period_end, change.currency, change.saved, change.current) == (
        date(2026, 12, 31),
        "USD",
        2.4,
        2.6,
    )
    assert change.saved_as_of == at
    assert (
        eps_changes(saved, observed(later.observed_at, ("0y", date(2026, 12, 31), "EUR", 2.6)))
        == []
    )
    assert eps_changes(later, saved) == []
    revenue = revenue_growth_changes(
        [(date(2026, 12, 31), 0.15, date(2026, 1, 2))],
        [(date(2026, 12, 31), 0.18, date(2026, 4, 2)), (date(2027, 12, 31), 0.1, None)],
    )
    assert [(c.metric, c.period_end, c.saved, c.current) for c in revenue] == [
        ("consensusRevenueGrowth", date(2026, 12, 31), 0.15, 0.18)
    ]


def test_assumption_changes_name_locked_fields():
    saved = saved_model(basis(statements(quarters())))
    base = INPUTS.model_copy(update={"revenue_cagr": 0.12, "discount_rate": 0.09})
    changes = assumption_changes(
        saved,
        {**dict.fromkeys(KEYS, INPUTS), "base": base},
        [LockedInput(scenario="base", field="discount_rate")],
    )
    assert [(c.scenario, c.field, c.saved, c.proposed, c.locked) for c in changes] == [
        ("base", "revenue_cagr", 0.08, 0.12, False),
        ("base", "discount_rate", 0.1, 0.09, True),
    ]


def test_a_new_reporting_currency_moves_the_rate_with_the_statements():
    old = basis(statements(quarters(), currency="EUR"), fx=1.1)
    new = basis(statements(quarters(1100.0)), spot=24.0)
    assert not fx_separable(old, new)
    saved = saved_model(old)
    walk = scenario_walk(saved, new, dict.fromkeys(KEYS, INPUTS), 5)
    at_saved_spot = new.model_copy(update={"spot": old.spot, "spot_as_of": old.spot_as_of})
    assert walk["base"].statements == project(at_saved_spot, INPUTS, 5).value
    assert walk["base"].price_fx_effect == 0
    figures = figure_changes(old, new)
    assert {f.metric for f in figures} <= {"startMargin", "listingShares"}
    with pytest.raises(ValueError, match="valuation-currency-changed"):
        scenario_walk(saved, new.model_copy(update={"currency": "GBP"}), {}, 5)


def test_figures_report_statement_inputs_in_their_reporting_currency():
    old = basis(statements(quarters(), currency="EUR"), fx=1.1)
    new = basis(statements(quarters(1100.0), currency="EUR"), fx=1.3)
    figures = {f.metric: f for f in figure_changes(old, new)}
    assert set(figures) == {"revenue", "startMargin"}
    assert (figures["revenue"].saved, figures["revenue"].currency) == (
        pytest.approx(4000),
        "EUR",
    )
    assert figures["revenue"].current == pytest.approx(4400)
    assert figures["startMargin"].current == pytest.approx(500 / 4400)
