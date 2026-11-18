"""Selection identity and financial coverage across retained synthetic publications."""

from dataclasses import replace
from zoneinfo import ZoneInfo

import pytest
from trading_max.research.news import NEWS_KEY

from services.api.tests.assistant_fixture import AS_OF, DATES, publication
from services.api.tests.test_assistant_page_roles import inputs
from services.api.trading_max_api.agent import attribution_role, exposure_role, market_roles, tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.agent.roles import role_registry
from services.api.trading_max_api.artifacts import ArtifactStore


def reader(tmp_path, role_name, context, *, files=None, **artifacts):
    store = ArtifactStore(tmp_path)
    publication(store, extra_artifacts=artifacts, extra_files=files)
    role = role_registry()[role_name]
    selected = role.context_schema.model_validate(context)
    return role.reader(AssistantDepsFactory(store).for_run(), selected), selected


def test_duplicate_ticker_uses_published_entity_on_both_dates(tmp_path):
    def records(day, weights):
        return {
            "available": True,
            "brokerAsOf": day + "T16:00:00Z",
            "investedValueGbp": 1000,
            "lookthroughCoveragePct": 1,
            "positions": [
                {
                    "entityId": entity,
                    "name": entity,
                    "ticker": "DUP",
                    "valueGbp": w * 1000,
                    "allocationPct": w,
                }
                for entity, w in zip(["issuer-A", "issuer-B"], weights, strict=True)
            ],
        }

    read, selection = reader(
        tmp_path,
        "exposure",
        {"dimension": "company", "category": "DUP", "entityId": "issuer-B"},
        **{
            tools.LOOKTHROUGH: records(DATES[-1], [0.8, 0.2]),
            "account/exposure_history/2026-01-04.json": records("2026-01-04", [0.9, 0.1]),
        },
    )
    result = read.read(exposure_role.selected_exposure, {})
    assert result["data"]["current"]["weight_fraction"] == 0.2
    assert result["data"]["previous"]["weight_fraction"] == 0.1
    legacy = selection.model_copy(update={"entityId": None})
    assert (
        not role_registry()["exposure"]
        .reader(read.deps, legacy)
        .read(exposure_role.selected_exposure, {})
        .get("data")
    )


@pytest.mark.parametrize(
    ("coverage", "other", "expected"),
    [(1, 1, "2026-01-04"), (0.5, 1, "2025-12-30"), (1, 0.9, "2025-12-30")],
)
def test_absent_allocation_requires_reconciled_complete_table(tmp_path, coverage, other, expected):
    def records(day, country, w):
        return {
            "available": True,
            "brokerAsOf": day + "T16:00:00Z",
            "countryBasis": "risk",
            "investedValueGbp": 1000,
            "lookthroughCoveragePct": 1,
            "countryAllocation": [{"country": country, "valueGbp": w * 1000, "allocationPct": w}],
        }

    read, _ = reader(
        tmp_path,
        "exposure",
        {"dimension": "country", "category": "US"},
        **{
            tools.LOOKTHROUGH: records(DATES[-1], "United States", 0.5),
            "account/exposure_history/2026-01-04.json": {
                **records("2026-01-04", "Japan", other),
                "lookthroughCoveragePct": coverage,
            },
            "account/exposure_history/2025-12-30.json": records("2025-12-30", "United States", 0.2),
        },
    )
    assert read.read(exposure_role.selected_exposure, {})["data"]["previous"] == {
        "date": expected,
        "weight_fraction": 0 if expected.endswith("01-04") else 0.2,
    }


def daily_reader(tmp_path, returns):
    nav = "Date,SyntheticNAVGBP,ExternalFlowGBP,TWRWealth,DailyReturn\n"
    wealth = 1
    for day, daily in zip(DATES, returns, strict=True):
        wealth *= 1 + (daily or 0)
        nav += f"{day},{wealth * 100},0,{wealth},{daily if daily is not None else ''}\n"
    return reader(
        tmp_path,
        "attribution",
        {"scope": "invest", "benchmark": "VOO", "start": DATES[0], "end": DATES[-1]},
        files={tools.HISTORY_KEYS[0]: nav},
    )


@pytest.mark.parametrize("missing", [False, True])
def test_selected_return_distinguishes_missing_intervals_from_pagination(tmp_path, missing):
    read, selection = daily_reader(
        tmp_path, [None, 0.05, None if missing else 0.02, None if missing else 0.01, 0.1]
    )
    result = read.read(attribution_role.selected_daily, {})
    assert result["status"] == ("partial" if missing else "ok")
    assert result["data"]["observed_intervals"] == (2 if missing else 4)
    assert result["data"]["total_intervals"] == 4
    observation = next(
        line
        for line in attribution_role.attribution_facts(read, selection)
        if line.section == "return"
    )
    if missing:
        assert result["data"]["window_twr_fraction"] == pytest.approx(0.155)
        assert "2 of 4" in observation.en and "2" in observation.zh
        assert "over this range" not in observation.en


def test_largest_move_includes_both_dates_and_direction(tmp_path):
    read, _ = daily_reader(tmp_path, [None, -0.02, 0.3, -0.01, 0.01])
    data = read.read(attribution_role.selected_daily, {})["data"]
    largest = data["largest_move"]
    assert (largest["from_date"], largest["date"], largest["return_fraction"]) == (
        DATES[1],
        DATES[2],
        0.3,
    )
    assert (data["observed_intervals"], data["total_intervals"]) == (4, 4)


@pytest.mark.parametrize("other_opening", [None, 100])
def test_total_fx_requires_only_its_chart_accounts_at_both_endpoints(tmp_path, other_opening):
    start = "2026-02-03T12:00:00Z"
    points = [
        {
            "observed_at": t,
            "total_value_gbp": value + (other or 0),
            "isa_value_gbp": value,
            "invest_value_gbp": other,
        }
        for t, value, other in [(start, 500, other_opening), (AS_OF, 420, None)]
    ]
    read, _ = reader(
        tmp_path,
        "attribution",
        {
            "scope": "broker_total",
            "view": "money",
            "range": "1D",
            "benchmark": "VOO",
            "start": start,
            "end": AS_OF,
        },
        **{
            tools.HISTORY_KEYS[3]: {"points": points},
            "account/attribution/window.json": {
                "day": DATES[-1],
                "start_day": DATES[0],
                "accounts": {
                    "B": {
                        "since": start,
                        "as_of": AS_OF,
                        "contributions": [
                            {
                                "ticker": "TEST",
                                "fx_effect_gbp": -34,
                                "local_price_effect_gbp": 10,
                                "contribution_gbp": -24,
                            }
                        ],
                    }
                },
            },
        },
    )
    data = read.read(attribution_role.selected_fx, {}).get("data")
    if other_opening is None:
        assert data and data["fx_effect_gbp"] == -34
    else:
        assert not data


def test_headline_uses_the_exchange_day_across_display_zones(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    publication(
        store,
        extra_artifacts={
            NEWS_KEY: {
                "securities": {
                    "TEST": {
                        "as_of": AS_OF,
                        "items": [
                            {
                                "title": "Tokyo morning lead",
                                "publisher": "Fixture Press",
                                "url": "https://example.org/tokyo",
                                "instant": "2026-02-02T23:30:00Z",
                            }
                        ],
                    }
                }
            }
        },
    )
    monkeypatch.setattr(
        market_roles,
        "market_sector",
        lambda ctx, args: {"data": {"day": DATES[-1], "news_ticker": "TEST"}},
    )
    role = role_registry()["market-sector"]
    selected = role.context_schema(market="jp", grouping="gics", sector="45", observed=AS_OF)
    for zone in ("Asia/Tokyo", "Europe/London"):
        deps = replace(
            AssistantDepsFactory(store).for_run(), page_sources=inputs(), timezone=ZoneInfo(zone)
        )
        result = role.reader(deps, selected).read(market_roles.sector_headline, {})
        assert result.get("data") and result["data"]["items"][0]["publisher"] == "Fixture Press"
