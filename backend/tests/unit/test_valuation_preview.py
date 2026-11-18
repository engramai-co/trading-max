import pytest
from trading_max.research.fundamentals import _levered_cashflow_value_per_share_v4
from trading_max.research.valuation_preview import (
    FrozenValuationBasis,
    ScenarioInputs,
    ValuationPreviewRequest,
    preview,
)


def fixture(horizon=5):
    basis = FrozenValuationBasis(
        ticker="TEST",
        quote_id="q1",
        data_version="v1",
        currency="USD",
        spot=20,
        revenue=10000,
        shares=100,
        start_margin=0.15,
    )
    params = ScenarioInputs(
        revenue_cagr=0.1,
        target_fcf_margin=0.2,
        discount_rate=0.1,
        exit_fcf_multiple=15,
        share_cagr=-0.01,
    )
    return basis, ValuationPreviewRequest(
        horizon=horizon, scenarios=dict.fromkeys(("bear", "base", "bull"), params)
    )


@pytest.mark.parametrize("horizon", [5, 10])
def test_preview_matrix_worksheet_and_existing_equity_formula_reconcile(horizon):
    basis, request = fixture(horizon)
    result = preview(basis, request)
    scenario = result.scenarios["base"]
    expected = _levered_cashflow_value_per_share_v4(
        revenue=10000,
        shares=100,
        growth=0.1,
        start_margin=0.15,
        target_margin=0.2,
        discount_rate=0.1,
        share_cagr=-0.01,
        years=horizon,
        exit_multiple=15,
    )
    assert scenario.value == pytest.approx(expected)
    assert scenario.value == pytest.approx(
        sum(y.present_value for y in scenario.years) + scenario.terminal_present_value
    )
    assert result.sensitivity[12].value == pytest.approx(expected)
    assert len(scenario.years) == horizon
    if horizon == 10:
        assert scenario.years[4].growth == 0.1
        assert scenario.years[-1].growth == pytest.approx(0.03)
    assert preview(basis, request).id == result.id


def test_preview_does_not_accept_a_changed_basis_or_enterprise_cashflow():
    basis, request = fixture()
    with pytest.raises(ValueError, match="version-changed"):
        preview(basis, request.model_copy(update={"data_version": "old"}))
    with pytest.raises(ValueError):
        FrozenValuationBasis.model_validate({**basis.model_dump(), "discountRateType": "WACC"})


def test_negative_cashflows_do_not_create_a_false_unique_implied_growth():
    basis, request = fixture()
    basis = basis.model_copy(update={"start_margin": -0.5, "opening_cash": 100})
    negative = request.scenarios["base"].model_copy(update={"target_fcf_margin": -0.2})
    request = request.model_copy(
        update={"scenarios": dict.fromkeys(("bear", "base", "bull"), negative)}
    )
    result = preview(basis, request)
    assert result.implied_growth is None
    assert result.implied_growth_bound is None
    assert result.reverse_metric == "target-margin"
    assert result.reverse_value is not None
    projection = result.scenarios["base"]
    assert projection.value == 0
    assert (
        projection.operating_value
        + projection.terminal_present_value
        + projection.equity_floor_adjustment
        == pytest.approx(projection.value)
    )


@pytest.mark.parametrize("years", [5, 10])
def test_residual_income_equals_dividends_plus_terminal_price(years):
    basis, _ = fixture()
    basis = basis.model_copy(update={"family": "residual-income", "book_per_share": 100})
    assumptions = ScenarioInputs(initial_roe=0.20, payout=0.5, terminal_pb=1.2, discount_rate=0.10)
    request = ValuationPreviewRequest(
        horizon=years, scenarios=dict.fromkeys(("bear", "base", "bull"), assumptions)
    )
    result = preview(basis, request)
    book = 100
    discounted_dividends = 0
    for i in range(years):
        earnings = book * (0.20 - i * 0.10 / (years - 1))
        discounted_dividends += earnings * 0.5 / 1.10 ** (i + 1)
        book += earnings * 0.5
    expected = discounted_dividends + 1.2 * book / 1.10**years
    assert result.scenarios["base"].value == pytest.approx(expected)
    assert result.scenarios["base"].years[-1].roe == pytest.approx(0.1)
    assert result.sensitivity[12].value == pytest.approx(expected)
    recovered = preview(basis.model_copy(update={"spot": expected}), request)
    assert recovered.reverse_metric == "initial-roe"
    assert recovered.reverse_value == pytest.approx(0.2)


@pytest.mark.parametrize("family", ["cash-flow", "net-income"])
def test_flat_operating_model_golden(family):
    basis, _ = fixture()
    basis = basis.model_copy(update={"family": family, "start_margin": 0.1})
    params = ScenarioInputs(
        discount_rate=0.1, target_fcf_margin=0.1, share_cagr=0, revenue_cagr=0, exit_fcf_multiple=10
    )
    reading = preview(
        basis, ValuationPreviewRequest(scenarios=dict.fromkeys(("bear", "base", "bull"), params))
    )
    # Five payments of ten per share followed by a terminal hundred.
    assert reading.scenarios["base"].value == pytest.approx(100)
    assert reading.sensitivity[12].value == pytest.approx(100)


def test_cash_deficit_issues_shares_once_and_legacy_replays_the_original_path():
    basis, _ = fixture()
    basis = basis.model_copy(
        update={"revenue": 100, "shares": 10, "spot": 10, "opening_cash": 5, "start_margin": -0.4}
    )
    params = ScenarioInputs(
        discount_rate=0.1,
        target_fcf_margin=0.2,
        share_cagr=0,
        revenue_cagr=0,
        exit_fcf_multiple=10,
        ramp_years=4,
    )
    request = ValuationPreviewRequest(scenarios=dict.fromkeys(("bear", "base", "bull"), params))
    reading = preview(basis, request)
    y = reading.scenarios["base"].years
    assert [r.free_cashflow for r in y] == pytest.approx([-25, -10, 5, 20, 20])
    assert [r.financing or 0 for r in y] == pytest.approx([20, 10, 0, 0, 0])
    assert [r.shares for r in y] == pytest.approx([12, 13, 13, 13, 13])
    expected = -5 / 12 / 1.1 + 5 / 13 / 1.1**3 + 20 / 13 / 1.1**4 + 220 / 13 / 1.1**5
    assert reading.scenarios["base"].value == pytest.approx(expected)
    assert reading.reverse_metric == "target-margin"
    from trading_max.research.valuation_preview import LEGACY_VERSION

    old = preview(basis, request.model_copy(update={"formula_version": LEGACY_VERSION}))
    assert old.scenarios["base"].years[0].free_cashflow == pytest.approx(-20)
    assert old.scenarios["base"].years[0].shares == 10
    assert old.implied_growth_reason == "non-monotonic-or-flat-cashflows"


def test_reverse_only_zero_revenue_has_no_scenario_range():
    basis, request = fixture()
    result = preview(basis.model_copy(update={"revenue": 0}), request)
    assert result.scenarios == {} and result.sensitivity == []
    assert result.reverse_metric == "year-five-revenue"
    assert result.reverse_value == pytest.approx(20 * 100 * (0.99 * 1.1) ** 5 / (0.2 * 15))
