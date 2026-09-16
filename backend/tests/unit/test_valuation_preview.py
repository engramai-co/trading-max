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
    basis = basis.model_copy(update={"start_margin": -0.5})
    negative = request.scenarios["base"].model_copy(update={"target_fcf_margin": -0.2})
    request = request.model_copy(
        update={"scenarios": dict.fromkeys(("bear", "base", "bull"), negative)}
    )
    result = preview(basis, request)
    assert result.implied_growth is None
    assert result.implied_growth_bound is None
    assert result.implied_growth_reason
    projection = result.scenarios["base"]
    assert projection.value == 0
    assert (
        projection.operating_value
        + projection.terminal_present_value
        + projection.equity_floor_adjustment
        == pytest.approx(projection.value)
    )
