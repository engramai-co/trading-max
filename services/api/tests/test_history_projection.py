from datetime import date

import pytest

from services.api.trading_max_api.dashboard_models import NavPoint
from services.api.trading_max_api.history_projection import (
    portfolio_day,
    project_intraday,
    scope_points,
    window_start,
)


def point(day, source="broker", **values):
    fields = {name: None for name, field in NavPoint.model_fields.items() if field.is_required()}
    return NavPoint(
        **{
            **fields,
            "date": day,
            "flow_status": "verified",
            "intraday": "T" in day,
            "valuation_source": source,
            "total": 100,
            "invest": 60,
            "isa": 40,
            "total_net_contributions_gbp": 80,
            **values,
        }
    )


@pytest.mark.parametrize(
    ("range_name", "expected"),
    [
        ("1D", "2026-09-18"),
        ("1W", "2026-09-14"),
        ("1M", "2026-08-18"),
        ("3M", "2026-06-18"),
        ("6M", "2026-03-18"),
        ("YTD", "2026-01-01"),
        ("1Y", "2025-09-18"),
        ("ALL", None),
    ],
)
def test_windows_match_london_calendar_and_weekend_rule(range_name, expected):
    result = window_start(date(2026, 9, 19), range_name)
    assert (result.isoformat() if result else None) == expected


def test_month_end_leap_year_and_london_midnight():
    assert window_start(date(2024, 3, 29), "1M") == date(2024, 2, 29)
    assert portfolio_day("2026-09-17T23:10:00Z") == date(2026, 9, 18)
    assert portfolio_day("2026-09-17") == date(2026, 9, 17)


def test_window_preserves_boundaries_and_every_financial_extremum_without_mutating_inputs():
    rows = [
        point("2026-03-18T12:00:00Z", "reconstructed"),
        point("2026-03-19T12:00:00Z", "reconstructed"),
        point("2026-08-10T12:00:00Z"),
        point("2026-08-11T12:00:00Z"),
        point("2026-09-18T12:00:00Z", total=150),
        point("2026-09-18T12:10:00Z", total=20),
        point("2026-09-18T12:20:00Z", total=110),
        point("2026-09-18T12:30:00Z", total=1000, total_net_contributions_gbp=None),
    ]
    result = project_intraday(
        rows, [], as_of="2026-09-18T13:00:00Z", range_name="1D", scope="total"
    )
    assert [p.date for p in result] == [rows[0].date, rows[2].date, *(p.date for p in rows[4:])]
    assert [p.total for p in result[-4:]] == [150, 20, 110, 1000]
    assert result[-1].total_net_contributions_gbp is None
    assert all(p.invest is None and p.isa is None for p in result)
    assert rows[0].invest == 60


def test_household_keeps_cfd_proxy_inputs_and_cfd_has_no_intraday():
    original = point(
        "2026-09-18",
        cfd=7,
        household=107,
        household_net_contributions_gbp=87,
        cfd_net_contributions_gbp=7,
    )
    scoped = scope_points([original], "household")[0]
    assert (scoped.total, scoped.cfd, scoped.household) == (100, 7, 107)
    assert scoped.total_net_contributions_gbp == 80
    assert scoped.household_net_contributions_gbp == 87
    assert scoped.invest is None
    assert project_intraday([original], [], as_of="2026-09-18", range_name="6M", scope="cfd") == []


def test_unrequested_projection_preserves_full_legacy_contract():
    rows = [point("2026-01-01T12:00:00Z"), point("2026-09-18T12:00:00Z")]
    assert project_intraday(rows, [], as_of="2026-09-18", range_name=None, scope=None) is rows


@pytest.mark.parametrize("scope", ["total", "household"])
def test_combined_account_detail_preserves_both_model_comparisons(scope):
    original = point("2026-09-18", invest_model_value_gbp=61, isa_model_value_gbp=42)
    projected = scope_points([original], scope)[0]
    assert projected.invest is None and projected.isa is None
    assert projected.invest_model_value_gbp + projected.isa_model_value_gbp == 103
