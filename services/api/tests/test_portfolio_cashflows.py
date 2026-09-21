import pytest

from services.api.trading_max_api.dashboard_models import NavPoint
from services.api.trading_max_api.portfolio_cashflows import CashFlowTimeline
from services.api.trading_max_api.projections.nav import intraday_nav_points


def history(*, verified=True):
    payload = {
        "covered_from": "2026-01-02T08:00:00Z",
        "covered_until": "2026-01-06T20:00:00Z",
        "verified": verified,
        "events": [
            {"occurred_at": "2026-01-02T08:00:00Z", "amount_gbp": 100},
            {"occurred_at": "2026-01-06T12:00:00Z", "amount_gbp": -20},
            {"occurred_at": "2026-01-06T12:00:00Z", "amount_gbp": 5},
        ],
    }
    for event in payload["events"]:
        event["accounting_date"] = event["occurred_at"][:10]
    return payload


def test_reads_the_typed_producer_envelope_with_either_alias_convention():
    from trading_max.analytics.cash_flow_history import AccountCashFlowHistory

    typed = AccountCashFlowHistory.model_validate(history())
    for aliases in (False, True):
        payload = typed.model_dump(mode="json", by_alias=aliases)
        assert CashFlowTimeline(payload).at("2026-01-06T12:00:00Z") == 85


def test_cash_flows_apply_at_the_event_time_and_stop_at_verified_coverage():
    flows = CashFlowTimeline(history())
    assert flows.at("2026-01-06T11:59:59Z") == 100
    assert flows.at("2026-01-06T12:00:00Z") == 85
    assert flows.at("2026-01-06T13:00:00+01:00") == 85
    assert flows.at("2026-01-02T07:59:59Z") is None
    assert flows.at("2026-01-06T20:00:01Z") is None
    assert CashFlowTimeline(history(verified=False)).at("2026-01-06T12:00:00Z") is None


@pytest.mark.parametrize(
    "bad",
    [
        None,
        {},
        {"verified": True},
        {**history(), "events": [{"occurred_at": "2026-01-02T08:00:00Z", "amount_gbp": "NaN"}]},
    ],
)
def test_invalid_or_missing_cash_flows_never_become_zero(bad):
    assert CashFlowTimeline(bad).at("2026-01-06T12:00:00Z") is None


def test_withdrawal_changes_nav_but_not_intraday_pnl_or_return_certification():
    payload = {
        "points": [
            {
                "observed_at": stamp,
                "invest_value_gbp": value,
                "isa_value_gbp": value,
                "total_value_gbp": 2 * value,
            }
            for stamp, value in [("2026-01-06T11:50:00Z", 110), ("2026-01-06T12:00:00Z", 95)]
        ]
    }
    points = intraday_nav_points(payload, {"invest": history(), "isa": history()})
    assert [point["totalNetContributionsGbp"] for point in points] == [200, 170]
    assert [point["totalNetPnlGbp"] for point in points] == [20, 20]
    assert all(point["totalTwr"] is None for point in points)
    # The complete API response validates each point, not just its calculations.
    assert all(NavPoint.model_validate(point).flow_status == "verified" for point in points)
    uncovered = intraday_nav_points(payload)
    assert all(point["totalNetPnlGbp"] is None for point in uncovered)


def test_each_broker_account_uses_its_own_observation_time():
    point = intraday_nav_points(
        {
            "points": [
                {
                    "observed_at": "2026-01-06T12:00:01Z",
                    "invest_observed_at": "2026-01-06T11:59:59Z",
                    "isa_observed_at": "2026-01-06T12:00:01Z",
                    "invest_value_gbp": 110,
                    "isa_value_gbp": 95,
                    "total_value_gbp": 205,
                }
            ]
        },
        {"invest": history(), "isa": history()},
    )[0]
    assert point["investNetContributionsGbp"] == 100
    assert point["isaNetContributionsGbp"] == 85
    assert point["totalNetPnlGbp"] == 20
