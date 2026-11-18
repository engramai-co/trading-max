"""Research selects prices and citations from the identified listing."""

import pytest
from fastapi.testclient import TestClient

from services.api.tests.test_assistant_insights import (
    DATES,
    ResearchPriceSeries,
    SecuritySearchResult,
    _call,
    broker_markers,
    distinct_listing_events,
    publish_trade_chart,
    republish,
    tools,
)
from services.api.tests.test_assistant_insights import (
    bound as bound,
)


@pytest.mark.parametrize("source", ["live", "unverified-alias"])
def test_london_route_rejects_unverified_or_foreign_prices(bound, monkeypatch, source):
    app, manifest, _ = bound
    store = app.state.store
    technical = store.read_json(manifest.run_id, tools.TECHNICAL)
    row = technical["rows"][0]
    row.update(ticker="TEST", exchange=None, currency="USD")
    republish(
        store,
        {
            tools.TECHNICAL: store.immutable_artifacts.put_json(
                key=tools.TECHNICAL, payload=technical
            )
        },
    )

    def live(*args, **kwargs):
        if source == "unverified-alias":
            raise ValueError("missing synthetic chart")
        return ResearchPriceSeries(
            ticker="TEST.L",
            exchange_calendar="XNYS",
            currency="USD",
            available_sessions=5,
            as_of=DATES[-1],
            points=row["price_series"],
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    response = TestClient(app).get(
        "/v1/research/TEST.L/prices", params={"interval": "60m" if source == "live" else "1d"}
    )
    assert response.status_code == 404
    assert not app.state.research._observed_prices


def test_retained_chart_after_watchlist_replacement(bound):
    from services.api.trading_max_api.agent.research_tools import PositionArgs, research_position

    app, _ = distinct_listing_events(bound, london_report=True)
    client = TestClient(app)
    series = client.get("/v1/research/SYN.L/prices").json()
    deps = app.state.assistant.deps_for_run("research", None)
    result = _call(
        deps,
        research_position,
        PositionArgs(ticker="SYN.L", published_series_id=series["publishedSeriesId"]),
    )
    params = {
        "tool": "research_position",
        "series": series["publishedSeriesId"],
        "snapshotId": deps.snapshot_id,
        "evidenceId": result["evidence_id"],
    }
    path = "/v1/research/SYN.L/citation"
    assert client.get(path, params=params).status_code == 200
    app.state.watchlist.remove("SYN.L")
    app.state.watchlist.add(
        SecuritySearchResult(ticker="SYN", name="US", exchange="NYSE", figi="", bloomberg_ticker="")
    )
    reopened = client.get(path, params=params)
    assert reopened.status_code == 200
    assert reopened.json()["output"]["data"] == result["data"]


def test_archived_trade_sets_position_baseline(bound):
    from services.api.trading_max_api.agent.research_tools import PositionArgs, research_position

    (buy,) = broker_markers([("SYNl_EQ", "Market buy", 2, 25)])
    buy.update(ticker="SYN.L", date=DATES[0])
    buy.pop("fills")
    app, _, chart = publish_trade_chart(bound, [buy], version="trade-markers-v1")
    assert chart["tradeMarkers"][0]["kind"] == "B"
    result = _call(
        app.state.assistant.deps_for_run("research", None),
        research_position,
        PositionArgs(ticker="SYN.L", published_series_id=chart["publishedSeriesId"]),
    )
    assert (result["data"]["trade_date"], result["data"]["start"], result["data"]["side"]) == (
        DATES[0],
        DATES[0],
        "buy",
    )


def test_observed_fund_distribution_qualifies_as_a_moment(bound):
    from services.api.trading_max_api.agent import insights

    app, manifest, _ = bound
    series = app.state.research.price_series("TEST", manifest, limit=2000)
    day = DATES[-1]
    observed = series.model_copy(
        update={
            "ticker": "FUND.L",
            "published_series_id": None,
            "published_bar_ticker": None,
            "events": [{"date": day + "T00:00:00+00:00", "kind": "dividend", "value": 0.2}],
        }
    )
    chart = app.state.research.observe_prices(observed, manifest.run_id)
    result = insights.moments_data(
        app.state.assistant.deps_for_run("research", None),
        insights.MomentsArgs(
            ticker="FUND.L",
            start=DATES[0],
            end=day,
            scope="broker_total",
            published_series_id=chart.observed_series_id,
        ),
    )
    assert any(
        e["kind"] == "dividend" and e["date"] == day
        for m in result["data"]["items"]
        for e in m["events"]
    )
