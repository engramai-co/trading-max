"""Research selects prices and citations from the identified listing."""

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_max.infrastructure import shared_market_prices as shared

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
from services.api.trading_max_api import research_prices


@pytest.mark.parametrize("source", ["live", "live-without-venue", "unverified-alias"])
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
            exchange_calendar="XNYS" if source == "live" else None,
            currency="USD",
            available_sessions=5,
            as_of=DATES[-1],
            points=row["price_series"],
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    response = TestClient(app).get(
        "/v1/research/TEST.L/prices",
        params={"interval": "1d" if source == "unverified-alias" else "60m"},
    )
    assert response.status_code == 404
    assert response.json() == json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "apps/web/tests/fixtures/listing-prices-unavailable.json"
        ).read_text()
    )
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
            "exchange_calendar": "XLON",
            "published_bar_exchange": "LSE",
            "published_bar_mic": "XLON",
            "venue_claims": (),
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


@pytest.mark.parametrize("provider_identity", [{}, {"exchangeName": "LSE"}, {"symbol": "TEST.L"}])
def test_live_route_requires_independent_listing_evidence(bound, monkeypatch, provider_identity):
    app, _, _ = bound
    frame = pd.DataFrame(
        {
            "Open": [31, 33],
            "High": [33, 35],
            "Low": [30, 32],
            "Close": [32, 34],
            "Volume": [100, 110],
        },
        index=pd.date_range("2026-01-28 13:30", periods=2, freq="h", tz="America/New_York"),
    )
    proxy = SimpleNamespace(
        history=lambda **kw: frame,
        get_history_metadata=lambda: {
            "currency": "USD",
            **provider_identity,
        },
    )
    monkeypatch.setattr(research_prices.yf, "Ticker", lambda ticker: proxy)
    response = TestClient(app).get("/v1/research/TEST.L/prices?interval=60m")
    if not provider_identity:
        chart = response.json()
        assert response.status_code == 404, (
            response.status_code,
            chart.get("ticker"),
            chart.get("exchangeCalendar"),
            chart.get("currency"),
            [row["close"] for row in chart.get("points", [])],
        )
    else:
        assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    ("identity", "expected"),
    [
        ({}, 404),
        ({"exchangeName": "LSE"}, 404),
        ({"symbol": "SMH.L"}, 404),
        ({"symbol": "SMH", "exchangeName": "NMS"}, 200),
    ],
)
def test_shared_close_history_requires_independent_venue_and_currency(
    bound, monkeypatch, identity, expected
):
    app, _, _ = bound
    now = datetime(2026, 1, 29, 20, tzinfo=UTC)
    provider_row = {
        "meta": {"currency": "GBP", **identity},
        "timestamp": [int(now.timestamp())],
        "indicators": {"quote": [{"close": [85.0]}]},
    }
    monkeypatch.setattr(
        shared,
        "_yahoo_get",
        lambda *_args: SimpleNamespace(
            status_code=200, json=lambda: {"chart": {"result": [provider_row]}}
        ),
    )
    monkeypatch.setattr(app.state, "market_prices", shared.SharedMarketPrices())
    monkeypatch.setattr(app.state.security_prices, "alpaca_etf", lambda *args: None)

    def no_ohlc(*args, **kwargs):
        raise ValueError("synthetic fixture has only closes")

    monkeypatch.setattr(app.state.security_prices, "get", no_ohlc)
    response = TestClient(app).get("/v1/research/SMH/prices?interval=60m")
    assert response.status_code == expected
    if expected == 200:
        chart = response.json()
        assert chart["currency"] == "GBP"
        assert chart["points"][0]["close"] == 85.0
