"""Each read agrees with its published page inputs and stays inside its pinned scope."""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from trading_max.analytics.day_attribution import update_day_attribution
from trading_max.analytics.exposure_history import (
    PREFIX,
    exposure_rows,
    record_exposure,
    retained_dates,
)
from trading_max.analytics.fx import FxQuote
from trading_max.analytics.key_moments import key_moments
from trading_max.analytics.ledger import load_transactions, transaction_marker_rows
from trading_max.portfolio_math import benchmark_comparison, in_range, period_return
from trading_max.research.held_funds import FUND_PRICES_KEY
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY

from services.api.tests.assistant_fixture import DATES, publication
from services.api.tests.test_assistant_tools import _call
from services.api.tests.test_dashboard import _measured_day, _publish_day_attribution
from services.api.trading_max_api.agent import insights as ins
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.dashboard import build_dashboard_data
from services.api.trading_max_api.dashboard_models import ResearchPriceSeries, ResearchTradeMarker
from services.api.trading_max_api.history_reader import HistoryReader
from services.api.trading_max_api.models import SecuritySearchResult


@pytest.fixture
def bound(tmp_path):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    manifest = publication(store)
    return app, manifest, app.state.assistant.deps_for_run(None, None)


@pytest.mark.parametrize(
    ("name", "args", "project"),
    [
        ("daily-returns", ins.DailyArgs(scope="invest", limit=1), ins.daily_data),
        ("holding-fx", ins.FXArgs(scope="broker_total", period="open_position"), ins.fx_data),
        (
            "dated-exposure",
            ins.ExposureHistoryArgs(
                scope="broker_total", dimension="country", on_or_before=DATES[-1]
            ),
            ins.exposure_data,
        ),
        ("decision-timing", ins.ReviewArgs(scope="invest"), ins.review_data),
        (
            "key-moments",
            ins.MomentsArgs(scope="invest", ticker="TEST", start=DATES[0], end=DATES[-1]),
            ins.moments_data,
        ),
    ],
)
def test_snapshot_http_matches_assistant_and_enforces_scope(bound, name, args, project):
    app, manifest, deps = bound
    publication(app.state.store, invest_total=9090)
    url = f"/v1/snapshots/{manifest.run_id}/insights/{name}"
    response = TestClient(app).get(url, params=args.model_dump(exclude_none=True))
    assert response.status_code == 200, response.text
    assert response.json() == project(deps, args)
    assert response.json()["sources"] and response.json()["snapshot_id"] == manifest.run_id
    denied = replace(deps, allowed_scopes=frozenset({"isa"}))
    with pytest.raises(ModelRetry):
        project(denied, args)


def test_invalid_dates_and_cursor_are_http_validation_errors(bound):
    app, manifest, _ = bound
    client = TestClient(app)
    base = f"/v1/snapshots/{manifest.run_id}/insights"
    assert (
        client.get(
            base + "/dated-exposure",
            params={"scope": "broker_total", "on_or_before": "2026-02-30", "dimension": "gics"},
        ).status_code
        == 422
    )
    assert (
        client.get(
            base + "/key-moments",
            params={"scope": "invest", "ticker": "TEST", "start": DATES[-1], "end": DATES[0]},
        ).status_code
        == 422
    )
    for dates in ({"start": DATES[0]}, {"end": DATES[-1]}, {"start": DATES[-1], "end": DATES[0]}):
        assert (
            client.get(base + "/daily-returns", params={"scope": "invest", **dates}).status_code
            == 422
        )
    assert (
        client.get(base + "/daily-returns", params={"scope": "invest", "cursor": "80"}).status_code
        == 422
    )


def test_daily_ranks_use_returns_page_wealth_and_cash_flow_dates(bound):
    app, manifest, deps = bound
    history = HistoryReader(app.state.store).read(manifest, "3M", "invest")
    nav = in_range([p.model_dump(mode="json") for p in history.nav], "3M")
    raw = deps.store.read_json(manifest.run_id, tools.TECHNICAL)
    chart = benchmark_comparison(nav, "invest", raw["benchmark_series"], ["VOO"])
    data = ins.daily_data(deps, ins.DailyArgs(scope="invest", range="1D"))["data"]
    rows = list(reversed(data["items"]))
    for i, row in enumerate(rows):
        a, b = chart["points"][i : i + 2]
        value = period_return(a["investTwr"], b["investTwr"])
        assert row["return_fraction"] == value
        assert row["worst_rank"] == 1 + sum(r["return_fraction"] < value for r in rows)
        before, after = chart["comparisons"][0]["values"][i : i + 2]
        assert row["benchmark_return_fractions"]["VOO"] == period_return(before, after)
    assert rows[-2]["date"] == "2026-02-02"
    assert rows[-2]["return_fraction"] == pytest.approx(1.10 / 1.05 - 1)
    assert rows[-2]["return_fraction"] != pytest.approx(1100 / 950 - 1)
    assert rows[-1]["worst_rank"] == 1
    assert ins.daily_data(deps, ins.DailyArgs(scope="cfd"))["status"] == "not_applicable"


def test_position_fx_is_the_holdings_page_figure(tmp_path, research_root, typed_fixture):
    store = ArtifactStore(tmp_path / "state")
    manifest = typed_fixture(research_root, store)
    holdings = build_dashboard_data(store, manifest)["holdings"]
    deps = AssistantDepsFactory(store).for_run()
    data = ins.fx_data(deps, ins.FXArgs(scope="broker_total", period="open_position"))["data"]
    for row in data["items"]:
        holding = next(
            h
            for h in holdings
            if h["ticker"] == row["ticker"] and tools.CODE_SCOPE[h["account"]] == row["scope"]
        )
        assert row["contribution_gbp"] == holding["pnlGbp"]
        assert row["fx_effect_gbp"] == holding["fxImpactGbp"]
        if row["fx_effect_gbp"] is not None:
            assert row["local_price_effect_gbp"] + row["fx_effect_gbp"] == pytest.approx(
                holding["pnlGbp"]
            )
    assert data["accounts"]["invest"]["fx_effect_gbp"] == -7.5


def test_exposure_pins_one_observation_per_london_date_and_retains_month_ends(bound):
    app, _, deps = bound
    artifacts = app.state.store.immutable_artifacts
    refs = {}
    original = deps.store.read_json(deps.snapshot_id, tools.LOOKTHROUGH)

    def write(stamp, positions):
        current = artifacts.put_json(
            key=tools.LOOKTHROUGH,
            payload={
                **original,
                "brokerAsOf": stamp,
                "positions": positions,
                "countryAllocation": [
                    {"country": "Taiwan", "valueGbp": 35, "allocationPct": 0.35},
                    {"country": "Taiwan Region", "valueGbp": 20, "allocationPct": 0.2},
                ],
            },
        )
        record_exposure(artifacts, refs, current.ref)

    companies = [{"name": str(i), "valueGbp": i, "allocationPct": i / 2000} for i in range(50)]
    write("unknown", companies)
    assert not refs
    write("2026-06-30T23:10:00Z", companies)
    write("2026-07-01T14:00:00Z", companies)
    write("2026-07-01T10:00:00Z", [])
    sample = artifacts.get_json(refs[PREFIX + "2026-07-01.json"].artifact_id).payload
    assert sample["brokerAsOf"] == "2026-06-30T23:10:00Z"
    assert len(sample["positions"]) == 50
    manifest = republish(app.state.store, refs)
    result = (
        TestClient(app)
        .get(
            f"/v1/snapshots/{manifest.run_id}/insights/dated-exposure",
            params={"scope": "broker_total", "on_or_before": "2026-07-01", "dimension": "company"},
        )
        .json()["data"]
    )
    assert result["total_items"] == result["company_limit"] == 40
    assert result["items"][0]["name"] == "49"
    assert exposure_rows(sample, "country") == [
        {"country": "Taiwan", "valueGbp": 55, "allocationPct": 0.55}
    ]
    end = date(2026, 11, 18)
    dates = [end - timedelta(days=i) for i in range(366 * 6)]
    kept = retained_dates(dates)
    assert len(kept) <= 35 + 60 and min(kept) >= date(2021, 12, 1)
    assert all(day in kept for day in dates[:35])
    assert date(2026, 8, 31) in kept and date(2026, 8, 30) not in kept
    absent = ins.exposure_data(
        deps,
        ins.ExposureHistoryArgs(scope="broker_total", dimension="gics", on_or_before="2026-01-01"),
    )
    assert absent["data"] == {"history_available_from": DATES[-1]}
    assert absent["sources"]


def test_moment_matches_visible_chart_bars_and_requires_a_dated_event(bound):
    app, manifest, deps = bound
    series = app.state.research.price_series("TEST", manifest)
    args = ins.MomentsArgs(
        scope="isa",
        ticker="TEST",
        start=DATES[0],
        end=DATES[-1],
        published_series_id=series.published_series_id,
    )
    data = ins.moments_data(deps, args)["data"]
    assert data["published_series_id"] == series.published_series_id
    assert [r["date"] for r in data["items"]] == [series.points[-1].date]
    assert data["items"][0]["move_fraction"] == pytest.approx(
        series.points[-1].close / series.points[-2].close - 1
    )
    assert data["items"][0]["events"] == [
        {"kind": "earnings", "date": DATES[-1], "reference": "synthetic-report"}
    ]
    assert (
        ins.moments_data(deps, args.model_copy(update={"published_series_id": "0" * 20}))["status"]
        == "unavailable"
    )
    bars = [
        {
            "date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(),
            "close": 100 + i % 2,
            "volume": 100 + i % 3 if i != 26 else 800,
        }
        for i in range(30)
    ]
    bars[23]["close"] = 200
    events = [{"date": b["date"], "kind": "filing", "reference": "synthetic"} for b in bars[23:28]]
    rows = key_moments(bars, events, bars[20]["date"], bars[26]["date"])
    assert len(rows) == 3
    assert {r["date"] for r in rows} == {bars[i]["date"] for i in [23, 24, 26]}
    assert next(r for r in rows if r["date"] == bars[26]["date"])["volume_z_score"] > 10


def test_checkable_events_filter_mixed_trades_to_the_requested_account(bound, monkeypatch):
    _, _, deps = bound
    day = DATES[-1]
    docs = {
        tools.ANALYST: {
            "rows": [
                {
                    "ticker": "TEST",
                    "analyst": {
                        "earningsEvents": [
                            {"date": day, "id": "e", "status": "reported"},
                            {"date": day, "id": "estimate", "status": "scheduled"},
                        ],
                        "upgradesDowngrades": [
                            {"epochGradeDate": 1770076800, "action": "up", "firm": "Agency"}
                        ],
                    },
                }
            ]
        },
        tools.FINANCIALS: {
            "rows": [
                {
                    "ticker": "TEST",
                    "financials": {"evidence": {"filings": [{"date": day, "accession": "filing"}]}},
                }
            ]
        },
        ins.TRADE_MARKERS: {
            "rows": [
                {
                    "ticker": "TEST",
                    "date": day,
                    "kind": "T",
                    "accounts": ["invest", "isa"],
                    "buy_quantity": 1,
                    "sell_quantity": 1,
                    "buy_orders": 1,
                    "sell_orders": 1,
                    "buy_average_price": 10,
                    "sell_average_price": 10,
                    "fills": [
                        {
                            "account": account,
                            "side": side,
                            "at": day,
                            "quantity": 1,
                            "amount": 10,
                            "currency": "GBP",
                        }
                        for account, side in (("invest", "buy"), ("isa", "sell"))
                    ],
                }
            ]
        },
    }
    for scope, marker in (("invest", "B"), ("isa", "S"), ("broker_total", "T")):
        args = ins.MomentsArgs(scope=scope, ticker="TEST", start=DATES[0], end=day)
        reader = tools._Read(deps, "price_key_moments", args, scope)
        monkeypatch.setattr(tools._Read, "read", lambda self, key: docs.get(key))
        events, _, issues = ins.dated_events(
            reader,
            args,
            reader.account_codes(scope),
            deps.price_series("TEST", deps.manifest).model_copy(
                update={
                    "trade_markers": [
                        ResearchTradeMarker.model_validate(row)
                        for row in docs[ins.TRADE_MARKERS]["rows"]
                    ],
                    "unresolved_trade_accounts": {},
                }
            ),
        )
        assert set(issues) == {
            "security_calendar_unavailable",
            "dividends_unavailable",
            "security_news_unavailable",
        }
        assert {(e["kind"], e["reference"]) for e in events} == {
            ("earnings", "e"),
            ("rating_change", "Agency"),
            ("filing", "filing"),
            ("own_trade", marker),
        }


def test_habits_count_only_decisions_with_an_observed_selected_window(bound, monkeypatch):
    _, _, deps = bound
    rows = [
        {
            "side": "buy",
            "observed_days": 21,
            "horizon_complete": True,
            "effect_horizon_gbp": 8,
            "effect_to_date_gbp": 10,
        },
        {"side": "sell", "observed_days": 2, "horizon_complete": False, "effect_to_date_gbp": -3},
        {"side": "buy", "observed_days": 0, "horizon_complete": False, "effect_to_date_gbp": 0},
        {"side": "buy", "observed_days": 5, "horizon_complete": False, "effect_to_date_gbp": 0},
    ]
    for day, row in zip(DATES, rows, strict=False):
        row.update(date=day, ticker="TEST")
    raw = {"accounts": {"A": {"status": "available", "as_of": DATES[-1], "decisions": rows}}}
    original = tools._Read.read
    monkeypatch.setattr(
        tools._Read,
        "read",
        lambda self, key: raw if key == tools.DECISIONS else original(self, key),
    )

    def habits(**kwargs):
        data = ins.review_data(deps, ins.ReviewArgs(scope="invest", **kwargs))["data"]
        return {h["side"]: h for h in data["habits"]}

    assert habits()["buy"]["evaluated"] == 1
    assert habits()["sell"]["effect_gbp"] is None
    assert habits(horizon="to_date")["buy"]["effect_gbp"] == 10
    assert habits(since=DATES[2], horizon="to_date")["buy"]["favourable_fraction"] == 0


def republish(store, replacements):
    refs = {r.key: r for r in store.immutable_snapshots.latest().manifest.artifacts}
    store.immutable_snapshots.publish(
        scope="all", source="synthetic", artifacts={**refs, **replacements}.values()
    )
    return store.latest_manifest()


@pytest.mark.parametrize("custom", [False, True])
def test_daily_ranks_use_scoped_observations_and_chart_dates(
    bound, custom, research_root, typed_fixture
):
    app, manifest, _ = bound
    store = app.state.store
    key = tools.HISTORY_KEYS[2]
    sunday = store.read_text(manifest.run_id, key) + "2026-02-01,20,100,100,-80\n"
    published = {ref.key: ref for ref in store.immutable_snapshots.latest().manifest.artifacts}
    benchmarks = store.read_json(manifest.run_id, tools.TECHNICAL)["benchmark_series"]
    full = typed_fixture(research_root, store)
    technical = store.read_json(full.run_id, tools.TECHNICAL)
    technical["benchmark_series"] = benchmarks
    manifest = republish(
        store,
        {
            **{k: published[k] for k in tools.HISTORY_KEYS[:2]},
            key: store.immutable_artifacts.put_bytes(
                key=key, content=sunday.encode(), media_type="text/csv"
            ),
            tools.TECHNICAL: store.immutable_artifacts.put_json(
                key=tools.TECHNICAL, payload=technical
            ),
        },
    )
    dates = DATES[2:4] if custom else DATES
    response = TestClient(app).get(
        "/v1/dashboard/lens/analytics", params={"range": "ALL", "scope": "invest"}
    )
    assert response.status_code == 200, response.text
    lens = response.json()
    assert lens["runId"] == manifest.run_id
    chart = benchmark_comparison(
        [p for p in lens["nav"] if dates[0] <= p["date"] <= dates[-1]],
        "invest",
        lens["benchmarkSeries"],
        ["VOO"],
    )
    opts = {"start": dates[0], "end": dates[-1]} if custom else {}
    response = TestClient(app).get(
        f"/v1/snapshots/{manifest.run_id}/insights/daily-returns",
        params={"scope": "invest", "range": "ALL", **opts},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["total_items"] == len(dates) - 1
    assert [r["date"] for r in reversed(data["items"])] == dates[1:]
    for i, row in enumerate(reversed(data["items"])):
        a, b = chart["points"][i : i + 2]
        assert (row["from_date"], row["date"]) == (a["date"], b["date"])
        assert row["return_fraction"] == period_return(a["investTwr"], b["investTwr"])
        assert row["benchmark_return_fractions"]["VOO"] == period_return(
            *chart["comparisons"][0]["values"][i : i + 2]
        )
    monday = next(r for r in data["items"] if r["date"] == "2026-02-02")
    assert monday["return_fraction"] == pytest.approx(1.10 / 1.05 - 1)


def test_daily_fx_withholds_stale_broker_observation(tmp_path, research_root, typed_fixture):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)
    stale = _measured_day([("BE", "BE_US_EQ", "5", "990", "1000")])
    stale["accounts"]["A"]["as_of"] = "2026-08-01T14:00:00Z"
    stale["accounts"]["A"]["contributions"][0].update(fx_effect_gbp=10, local_price_effect_gbp=0)
    _publish_day_attribution(store, stale)
    assert (
        next(h for h in build_dashboard_data(store)["holdings"] if h["ticker"] == "BE")[
            "dayChangeGbp"
        ]
        is None
    )
    data = ins.fx_data(
        AssistantDepsFactory(store).for_run(), ins.FXArgs(scope="invest", period="1D")
    )
    assert data["status"] == "unavailable"


def test_ambiguous_legacy_share_change_withholds_holdings_line_and_fx_account_subtotal(
    tmp_path, research_root, typed_fixture
):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)

    def observed(hour, quantity, value):
        return {
            "A": {
                "fetched_at": f"2026-08-01T{hour}:00:00Z",
                "positions": [
                    {
                        "ticker": "BE",
                        "broker_ticker": "BE_US_EQ",
                        "quantity": quantity,
                        "current_value_gbp": value,
                    }
                ],
            }
        }

    before, _ = update_day_attribution(None, observed(10, 10, 800))
    _, day = update_day_attribution(
        before.model_dump(mode="json", by_alias=False), observed(19, 20, 700)
    )
    _publish_day_attribution(store, day.model_dump(mode="json", by_alias=False))
    holdings = build_dashboard_data(store)["holdings"]
    assert next(h["dayChangeGbp"] for h in holdings if h["ticker"] == "BE") is None
    reading = ins.fx_data(
        AssistantDepsFactory(store).for_run(), ins.FXArgs(scope="invest", period="1D")
    )
    assert reading["status"] == "partial"
    assert reading["data"]["items"] == []
    for field in ("contribution_gbp", "local_price_effect_gbp", "fx_effect_gbp"):
        assert reading["data"]["accounts"]["invest"][field] is None


def test_habit_default_and_focused_decision_match_review(bound):
    app, _, _ = bound
    store = app.state.store
    rows = [
        {
            "date": DATES[0],
            "ticker": "TEST",
            "side": "buy",
            "observed_days": 21,
            "horizon_complete": True,
            "effect_horizon_gbp": -15,
            "effect_to_date_gbp": -20,
        },
        {
            "date": DATES[-1],
            "ticker": "TEST",
            "side": "buy",
            "observed_days": 1,
            "horizon_complete": False,
            "effect_to_date_gbp": 10,
        },
    ]
    key = tools.DECISIONS
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_json(
                key=key,
                payload={
                    "accounts": {
                        "A": {"status": "available", "as_of": DATES[-1], "decisions": rows}
                    }
                },
            )
        },
    )

    def result(**args):
        response = TestClient(app).get(
            f"/v1/snapshots/{manifest.run_id}/insights/decision-timing",
            params={"scope": "invest", **args},
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        buy = data["habits"][0]
        return data["horizon"], buy["effect_gbp"], buy["evaluated"]

    assert result() == ("20_sessions", -15, 1)
    assert result(horizon="to_date") == ("to_date", -10, 2)
    assert result(ticker="TEST", decision_date=DATES[-1], side="buy") == ("to_date", 10, 1)


@pytest.mark.parametrize("watchlisted", [False, True])
def test_aliased_listing_moments_match_returned_chart_identity(bound, watchlisted):
    app, manifest, _ = bound
    store = app.state.store
    changes = {}
    for key in (tools.TECHNICAL, tools.ANALYST):
        raw = store.read_json(manifest.run_id, key)
        raw["rows"][0]["ticker"] = "SYN.L"
        changes[key] = store.immutable_artifacts.put_json(key=key, payload=raw)
    manifest = republish(store, changes)
    if watchlisted:
        app.state.watchlist.add(
            SecuritySearchResult(
                ticker="SYN.L", name="Synthetic", exchange="LSE", bloomberg_ticker="", figi=""
            )
        )
    series = TestClient(app).get("/v1/research/SYN/prices").json()
    assert len(series["points"]) == 5 and series["ticker"] == ("SYN.L" if watchlisted else "SYN")
    response = TestClient(app).get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={
            "ticker": "SYN",
            "published_series_id": series["publishedSeriesId"],
            "scope": "isa",
            "start": DATES[0],
            "end": DATES[-1],
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data is not None
    assert data["published_series_id"] == series["publishedSeriesId"]
    assert data["items"][0]["events"][0]["reference"] == "synthetic-report"
    if watchlisted:
        deps = app.state.assistant.deps_for_run(None, None)
        app.state.watchlist.add(
            SecuritySearchResult(
                ticker="SYN", name="US listing", exchange="NYSE", bloomberg_ticker="", figi=""
            )
        )
        args = ins.MomentsArgs(
            ticker="SYN",
            scope="isa",
            start=DATES[0],
            end=DATES[-1],
            published_series_id=series["publishedSeriesId"],
        )
        pinned = ins.moments_data(deps, args)
        assert pinned["data"]["ticker"] == "SYN.L"
        assert pinned["data"]["published_series_id"] == series["publishedSeriesId"]
        new_run = ins.moments_data(app.state.assistant.deps_for_run(None, None), args)
        assert new_run["data"] is None
        assert new_run["quality"]["reason_code"] == "published_daily_bars_unavailable"


def distinct_listing_events(bound, *, london_report=False):
    app, manifest, _ = bound
    store = app.state.store
    technical = store.read_json(manifest.run_id, tools.TECHNICAL)
    london = {**technical["rows"][0], "ticker": "SYN.L"}
    us_bars = [
        {**p, "close": close}
        for p, close in zip(london["price_series"], [32, 32, 34, 30, 40], strict=True)
    ]
    technical["rows"] = [london, {**london, "ticker": "SYN", "price_series": us_bars}]
    day = DATES[-1]
    analyst = [
        {
            "ticker": "SYN",
            "analyst": {
                "earningsEvents": [{"date": day, "status": "reported", "id": "US-earnings"}],
                "upgradesDowngrades": [{"index": day, "action": "up", "firm": "US-rating"}],
            },
        }
    ]
    if london_report:
        analyst.append(
            {
                "ticker": "SYN.L",
                "analyst": {
                    "earningsEvents": [{"date": day, "status": "reported", "id": "London-earnings"}]
                },
            }
        )
    payloads = {
        tools.TECHNICAL: technical,
        tools.ANALYST: {"rows": analyst},
        tools.FINANCIALS: {
            "rows": [
                {
                    "ticker": "SYN",
                    "financials": {"evidence": {"filings": [{"date": day, "id": "US-filing"}]}},
                }
            ]
        },
        ins.TRADE_MARKERS: {
            "rows": broker_markers([("SYN_US_EQ", "Market buy", 1, 40)]),
            "calculation_version": "trade-markers-v3",
        },
    }
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=raw)
            for key, raw in payloads.items()
        },
    )
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker="SYN.L", name="London listing", exchange="LSE", bloomberg_ticker="", figi=""
        )
    )
    return app, f"/v1/snapshots/{manifest.run_id}/insights/key-moments"


def broker_markers(instruments):
    positions = [{"ticker": "SYN", "broker_ticker": "SYNl_EQ", "isin": "GB0000000001"}]
    rows = [
        {
            "Ticker": instrument,
            "ISIN": positions[0]["isin"],
            "Action": action,
            "Time": pd.Timestamp(f"{DATES[-1]}T12:00:00Z"),
            "Shares": quantity,
            "PriceN": price,
            "TotalN": quantity * price,
            "Currency (Total)": "GBP",
            "Currency (Price / share)": "GBP",
        }
        for instrument, action, quantity, price in instruments
    ]
    return transaction_marker_rows({"isa": pd.DataFrame(rows)}, positions)


def listing_trade_readings(app, manifest, ticker):
    client = TestClient(app)
    chart = client.get(f"/v1/research/{ticker}/prices").json()
    moments = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={
            "ticker": ticker,
            "scope": "isa",
            "start": DATES[0],
            "end": DATES[-1],
            "published_series_id": chart["publishedSeriesId"],
        },
    ).json()
    events = [
        e["reference"]
        for item in moments["data"]["items"]
        for e in item["events"]
        if e["kind"] == "own_trade"
    ]
    markers = [
        (m["ticker"], m["kind"], m["buyQuantity"], m["sellQuantity"]) for m in chart["tradeMarkers"]
    ]
    return markers, events


@pytest.mark.parametrize("include_us", [False, True])
def test_chart_and_moments_route_published_broker_fills_by_listing(bound, include_us):
    app, _ = distinct_listing_events(bound)
    app.state.watchlist.add(
        SecuritySearchResult(ticker="SYN", name="US", exchange="NYSE", bloomberg_ticker="", figi="")
    )
    orders = [("SYNl_EQ", "Market buy", 2, 30)]
    if include_us:
        orders.extend([("SYN_US_EQ", "Market sell", 3, 40), ("SYN", "Market buy", 10, 5)])
    rows = broker_markers(orders)
    store = app.state.store
    ref = store.immutable_artifacts.put_json(
        key=ins.TRADE_MARKERS, payload={"rows": rows, "calculation_version": "trade-markers-v3"}
    )
    manifest = republish(store, {ins.TRADE_MARKERS: ref})
    assert listing_trade_readings(app, manifest, "SYN.L") == ([("SYN.L", "B", 2, 0)], ["B"])
    expected_us = ([("SYN", "S", 0, 3)], ["S"]) if include_us else ([], [])
    assert listing_trade_readings(app, manifest, "SYN") == expected_us
    assert {f["broker_ticker"] for row in rows for f in row["fills"]} == {o[0] for o in orders}


def test_bare_csv_fill_survives_marker_replay_on_its_unique_published_listing(bound, tmp_path):
    app, initial, _ = bound
    store = app.state.store
    broker = store.read_json(initial.run_id, tools.BROKER)
    position = broker["accounts"]["A"]["positions"][0]
    position.update(ticker="SYN", broker_ticker="SYNl_EQ", isin="GB0000000001")
    technical = store.read_json(initial.run_id, tools.TECHNICAL)
    technical["rows"][0]["ticker"] = "SYN.L"
    refs = {
        key: store.immutable_artifacts.put_json(key=key, payload=payload)
        for key, payload in ((tools.BROKER, broker), (tools.TECHNICAL, technical))
    }
    csv = tmp_path / "transactions.csv"
    csv.write_text(
        "Action,Time (UTC),ISIN,Ticker,No. of shares,Price / share,Total,Currency (Total)\n"
        f"Market buy,{DATES[-1]}T12:00:00Z,GB0000000001,SYN,2,30,60,GBP\n"
    )
    expected = ([("SYN.L", "B", 2, 0)], ["B"])
    for version in ("trade-markers-v1", "trade-markers-v3"):
        rows = transaction_marker_rows({"isa": load_transactions([csv])}, [position])
        assert rows[0]["fills"][0]["broker_ticker"] == "SYN"
        if version == "trade-markers-v1":
            rows[0]["fills"][0].pop("broker_ticker")
            rows[0]["fills"][0].pop("price", None)
        key = ins.TRADE_MARKERS
        refs[key] = store.immutable_artifacts.put_json(
            key=key, payload={"calculation_version": version, "rows": rows}
        )
        manifest = republish(store, refs)
        assert listing_trade_readings(app, manifest, "SYN.L") == expected, version
        query = {"scope": "isa", "ticker": "SYN.L", "start": DATES[0], "end": DATES[-1]}
        result = (
            TestClient(app)
            .get(f"/v1/snapshots/{manifest.run_id}/insights/key-moments", params=query)
            .json()
        )
        assert "trade_listing_unresolved" not in result["quality"]["issues"]

    technical["rows"].append({**technical["rows"][0], "ticker": "SYN"})
    key = tools.TECHNICAL
    manifest = republish(
        store, {key: store.immutable_artifacts.put_json(key=key, payload=technical)}
    )
    for ticker in ("SYN.L", "SYN"):
        assert listing_trade_readings(app, manifest, ticker) == ([], [])


@pytest.mark.parametrize(
    ("second_order", "expected"),
    [
        (("SYNl_EQ", "Market sell", 1, 31), ([("SYN.L", "T", 2, 1)], ["T"])),
        (("SYN_US_EQ", "Market sell", 1, 40), ([], [])),
        (("SYNALT", "Market sell", 1, 40), ([("SYN.L", "B", 2, 0)], ["B"])),
    ],
)
def test_replayed_bare_fill_uses_its_own_symbol_and_other_fills_listing_evidence(
    bound, second_order, expected
):
    app, initial, _ = bound
    store = app.state.store
    technical = store.read_json(initial.run_id, tools.TECHNICAL)
    technical["rows"][0]["ticker"] = "SYN.L"
    rows = broker_markers([("SYN", "Market buy", 2, 30), second_order])
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=payload)
            for key, payload in (
                (tools.TECHNICAL, technical),
                (ins.TRADE_MARKERS, {"calculation_version": "trade-markers-v3", "rows": rows}),
            )
        },
    )
    assert listing_trade_readings(app, manifest, "SYN.L") == expected


def test_replayed_day_uses_priced_shares_for_its_combined_average(bound):
    app, initial, _ = bound
    store = app.state.store
    technical = store.read_json(initial.run_id, tools.TECHNICAL)
    technical["rows"][0].update(ticker="SYN.L", currency="GBP")
    rows = broker_markers(
        [
            ("SYN", "Market buy", 2, 30),
            ("SYNl_EQ", "Market buy", 3, 40),
            ("SYNl_EQ", "Market buy", 5, float("nan")),
        ]
    )
    republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=payload)
            for key, payload in (
                (tools.TECHNICAL, technical),
                (ins.TRADE_MARKERS, {"calculation_version": "trade-markers-v3", "rows": rows}),
            )
        },
    )
    (marker,) = TestClient(app).get("/v1/research/SYN.L/prices").json()["tradeMarkers"]
    assert (marker["buyOrders"], marker["buyQuantity"], marker["buyAveragePrice"]) == (3, 10, 36)
    assert len(marker["fills"]) == 3


def publish_trade_chart(
    bound,
    rows,
    *,
    currency="GBP",
    version="trade-markers-v4",
    ticker="SYN.L",
    price_key=tools.TECHNICAL,
):
    app, initial, _ = bound
    store = app.state.store
    technical = store.read_json(initial.run_id, tools.TECHNICAL)
    technical["rows"][0].update(ticker=ticker, currency=currency)
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=payload)
            for key, payload in (
                (price_key, technical),
                (ins.TRADE_MARKERS, {"calculation_version": version, "rows": rows}),
            )
        },
    )
    series = TestClient(app).get(f"/v1/research/{ticker}/prices").json()
    assert series["currency"] == currency
    return app, manifest, series


@pytest.mark.parametrize(
    ("ticker", "instrument", "key", "provider"),
    [
        ("SYN.L", "SYNl_EQ", tools.TECHNICAL, "get"),
        ("SPY", "SPY_US_EQ", FUND_PRICES_KEY, "alpaca_etf"),
    ],
)
@pytest.mark.parametrize(
    ("quote", "usd_per_gbp", "expected"),
    [("USD", None, 30), ("EUR", "1.4", 35), ("EUR", None, None)],
)
def test_live_chart_prices_fills_in_its_returned_currency(
    bound, monkeypatch, ticker, instrument, key, provider, quote, usd_per_gbp, expected
):
    rows = broker_markers([(instrument, "Market buy", 2, 30)])
    fill = rows[0]["fills"][0]
    fill.update(price_currency=quote, currency="GBP", amount=50, exchange_rate=1.2)
    if usd_per_gbp:
        fill["price_fx"] = {
            "USD": FxQuote(
                "USD", Decimal(usd_per_gbp), datetime.fromisoformat(fill["at"]), "synthetic-close"
            ).as_dict()
        }
    app, manifest, daily = publish_trade_chart(bound, rows, ticker=ticker, price_key=key)
    assert daily["tradeMarkers"][0]["buyAveragePrice"] == 25

    def hourly(symbol, interval, **kwargs):
        assert (symbol, interval) == (ticker, "60m")
        return ResearchPriceSeries.model_validate(
            {
                **daily,
                "currency": "USD",
                "actualInterval": interval,
                "tradeMarkers": [],
                "points": [{**daily["points"][-1], "date": DATES[-1] + "T14:00:00Z", "close": 30}],
            }
        )

    monkeypatch.setattr(app.state.security_prices, provider, hourly)
    live = TestClient(app).get(f"/v1/research/{ticker}/prices?interval=60m").json()
    assert (live["currency"], live["actualInterval"]) == ("USD", "60m")
    (marker,) = live["tradeMarkers"]
    assert marker["fills"] == daily["tradeMarkers"][0]["fills"]
    assert marker["buyAveragePrice"] == expected
    assert (
        app.state.research.price_series(ticker, manifest).trade_markers[0].buy_average_price == 25
    )


@pytest.mark.parametrize(
    ("first_ticker", "quote", "price", "rate", "target", "expected"),
    [
        ("SYN", "GBX", 2500, None, "GBP", 25),
        ("SYNl_EQ", "GBp", 2500, None, "GBP", 25),
        ("SYN", "USD", 40, 1.25, "GBP", 27.8),
        ("SYN", "GBX", 2000, 80, "USD", 25),
        ("SYN", "EUR", 40, 0, "GBP", None),
        ("SYN", None, 40, 1, "GBP", None),
    ],
)
def test_trade_marker_converts_each_fill_before_weighting(
    bound, tmp_path, first_ticker, quote, price, rate, target, expected
):
    export = tmp_path / "synthetic.csv"
    export.write_text(
        "Action,Time (UTC),Ticker,No. of shares,Price / share,Currency (Price / share),"
        "Total,Currency (Total),Exchange rate\n"
        f"Market buy,{DATES[-1]}T11:00:00Z,{first_ticker},2,{price},{quote or ''},50,{target},{rate or ''}\n"
        f"Market buy,{DATES[-1]}T12:00:00Z,SYNl_EQ,3,25,{target},75,{target},1\n"
    )
    rows = transaction_marker_rows({"isa": load_transactions([export])}, [])
    _, _, chart = publish_trade_chart(bound, rows, currency=target)
    (marker,) = chart["tradeMarkers"]
    assert (marker["buyOrders"], marker["buyQuantity"], marker["buyAveragePrice"]) == (
        2,
        5,
        expected,
    )
    assert marker["fills"][0]["currency"] == target


@pytest.mark.parametrize(("age", "average"), [(1, 30), (8, None), (-1, None)])
def test_marker_cross_uses_only_dated_exchange_rates_in_its_snapshot(bound, age, average):
    def fx(currency, at):
        return FxQuote(
            currency,
            Decimal({"USD": "1.25", "EUR": "1.5"}[currency]),
            at - timedelta(days=age),
            "synthetic-close",
        )

    positions = [{"ticker": "SYN", "broker_ticker": "SYNl_EQ", "price_currency": "EUR"}]
    tx = pd.DataFrame(
        [
            {
                "Ticker": "SYNl_EQ",
                "Action": "Market sell",
                "Time": pd.Timestamp(f"{DATES[-1]}T14:00:00Z"),
                "Shares": 2,
                "PriceN": 25,
                "Currency (Price / share)": "USD",
                "TotalN": 50,
                "Currency (Total)": "USD",
            }
        ]
    )
    rows = transaction_marker_rows({"isa": tx}, positions, fx_resolver=fx)
    _, _, series = publish_trade_chart(bound, rows, currency="EUR")
    (marker,) = series["tradeMarkers"]
    assert marker["sellAveragePrice"] == average
    assert marker["sellOrders"] == 1 and marker["fills"][0]["amount"] == 50


def test_marker_uses_dated_wallet_fx_when_export_omits_the_fill_rate(bound):
    def fx(currency, at):
        return FxQuote(
            currency, Decimal({"USD": "1.25", "EUR": "1.5"}[currency]), at, "synthetic-close"
        )

    tx = pd.DataFrame(
        [
            {
                "Ticker": "SYNl_EQ",
                "Action": "Market buy",
                "Time": pd.Timestamp(f"{DATES[-1]}T14:00:00Z"),
                "Shares": 2,
                "PriceN": 30,
                "Currency (Price / share)": "EUR",
                "TotalN": 50,
                "Currency (Total)": "USD",
            }
        ]
    )
    rows = transaction_marker_rows({"isa": tx}, [], fx_resolver=fx)
    _, _, series = publish_trade_chart(bound, rows, currency="USD")
    assert series["tradeMarkers"][0]["buyAveragePrice"] == 25


@pytest.mark.parametrize("detail", ["fills", "aggregates", "mixed"])
def test_legacy_listing_aliases_contribute_one_scoped_daily_marker(bound, detail):
    (buy,) = broker_markers([("SYN", "Market buy", 2, 25)])
    (sell,) = broker_markers([("SYNl_EQ", "Market sell", 3, 25)])
    buy["ticker"], sell["ticker"] = "SYN", "SYN.L"
    sell["accounts"] = ["invest"]
    sell["fills"][0]["account"] = "invest"
    for row in (buy, sell):
        row["fills"][0].pop("broker_ticker")
        row["fills"][0].pop("price")
        row["fills"][0].pop("price_currency")
        if detail == "aggregates" or (detail == "mixed" and row is sell):
            row.pop("fills")
    app, manifest, chart = publish_trade_chart(bound, [buy, sell], version="trade-markers-v1")
    (marker,) = chart["tradeMarkers"]
    assert (marker["kind"], marker["buyOrders"], marker["sellOrders"]) == ("T", 1, 1)
    assert (marker["buyQuantity"], marker["sellQuantity"]) == (2, 3)
    assert marker["accounts"] == ["invest", "isa"]
    client = TestClient(app)
    for scope, kind in (("broker_total", "T"), ("isa", "B"), ("invest", "S")):
        data = client.get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"scope": scope, "ticker": "SYN.L", "start": DATES[0], "end": DATES[-1]},
        ).json()["data"]
        assert [
            e["reference"]
            for item in data["items"]
            for e in item["events"]
            if e["kind"] == "own_trade"
        ] == [kind]


@pytest.mark.parametrize("aggregate_only", [False, True])
def test_legacy_marker_requires_a_unique_published_listing(bound, aggregate_only):
    app, _ = distinct_listing_events(bound)
    app.state.watchlist.add(
        SecuritySearchResult(ticker="SYN", name="US", exchange="NYSE", bloomberg_ticker="", figi="")
    )
    store = app.state.store
    rows = broker_markers([("SYNl_EQ", "Market buy", 2, 30)])
    if aggregate_only:
        rows[0].pop("fills")
    else:
        rows[0]["fills"][0].pop("broker_ticker", None)
    ref = store.immutable_artifacts.put_json(
        key=ins.TRADE_MARKERS, payload={"rows": rows, "calculation_version": "trade-markers-v1"}
    )
    manifest = republish(store, {ins.TRADE_MARKERS: ref})
    assert listing_trade_readings(app, manifest, "SYN.L") == ([], [])
    assert listing_trade_readings(app, manifest, "SYN") == ([], [])

    technical = store.read_json(manifest.run_id, tools.TECHNICAL)
    technical["rows"] = [row for row in technical["rows"] if row["ticker"] == "SYN.L"]
    ref = store.immutable_artifacts.put_json(key=tools.TECHNICAL, payload=technical)
    manifest = republish(store, {tools.TECHNICAL: ref})
    assert listing_trade_readings(app, manifest, "SYN.L") == ([("SYN.L", "B", 2, 0)], ["B"])


@pytest.mark.parametrize(("code", "ticker"), [("SYNL_EQ", "SYN.L"), ("SYN_US_EQ", "SYN")])
def test_legacy_export_code_matches_one_published_listing(bound, code, ticker):
    app, _ = distinct_listing_events(bound)
    app.state.watchlist.add(
        SecuritySearchResult(ticker="SYN", name="US", exchange="NYSE", bloomberg_ticker="", figi="")
    )
    store = app.state.store
    # The original publisher uppercased the export code when a holding had no known alias.
    rows = broker_markers([("SYNl_EQ", "Market buy", 1, 30)])
    rows[0].pop("fills")
    rows[0]["ticker"] = code
    ref = store.immutable_artifacts.put_json(key=ins.TRADE_MARKERS, payload={"rows": rows})
    broker = store.read_json(store.latest_manifest().run_id, tools.BROKER)
    broker["accounts"]["A"]["positions"][0].update(ticker="SYN", broker_ticker="SYNl_EQ")
    broker_ref = store.immutable_artifacts.put_json(key=tools.BROKER, payload=broker)
    manifest = republish(store, {ins.TRADE_MARKERS: ref, tools.BROKER: broker_ref})
    assert listing_trade_readings(app, manifest, ticker) == ([(ticker, "B", 1, 0)], ["B"])
    other = "SYN" if ticker == "SYN.L" else "SYN.L"
    assert listing_trade_readings(app, manifest, other) == ([], [])


def test_legacy_marker_checks_broker_listing_even_when_only_one_chart_exists(bound):
    app, manifest, _ = bound
    store = app.state.store
    technical = store.read_json(manifest.run_id, tools.TECHNICAL)
    technical["rows"][0]["ticker"] = "SYN.L"
    rows = broker_markers([("SYNl_EQ", "Market buy", 2, 30)])
    rows[0].pop("fills")
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=payload)
            for key, payload in ((tools.TECHNICAL, technical), (ins.TRADE_MARKERS, {"rows": rows}))
        },
    )
    assert listing_trade_readings(app, manifest, "SYN.L") == ([("SYN.L", "B", 2, 0)], ["B"])

    broker = store.read_json(manifest.run_id, tools.BROKER)
    broker["accounts"]["A"]["positions"][0].update(ticker="SYN", broker_ticker="SYN_US_EQ")
    ref = store.immutable_artifacts.put_json(key=tools.BROKER, payload=broker)
    manifest = republish(store, {tools.BROKER: ref})
    assert listing_trade_readings(app, manifest, "SYN.L") == ([], [])


def test_mixed_publication_never_reuses_another_listings_price_or_account(bound):
    app, _ = distinct_listing_events(bound)
    store = app.state.store
    # A v3 publisher can keep fills from several listings in one daily marker.
    rows = broker_markers([("SYNl_EQ", "Market buy", 2, 30), ("SYNl_EQ", "Market sell", 1, 31)])
    extra = broker_markers([("SYN_US_EQ", "Market buy", 3, 40)])[0]["fills"][0]
    rows[0]["fills"].append({**extra, "account": "invest"})
    for fill in rows[0]["fills"]:
        fill.pop("price", None)  # The earlier publication supplied only unitless side averages.
        fill.pop("price_currency", None)
    rows[0].update(buy_orders=2, buy_quantity=5, buy_average_price=36, accounts=["isa", "invest"])
    ref = store.immutable_artifacts.put_json(
        key=ins.TRADE_MARKERS, payload={"rows": rows, "calculation_version": "trade-markers-v3"}
    )
    manifest = republish(store, {ins.TRADE_MARKERS: ref})
    assert listing_trade_readings(app, manifest, "SYN.L") == ([("SYN.L", "T", 2, 1)], ["T"])
    client = TestClient(app)
    (marker,) = client.get("/v1/research/SYN.L/prices").json()["tradeMarkers"]
    assert marker["accounts"] == ["isa"] and len(marker["fills"]) == 2
    assert marker["buyAveragePrice"] is None and marker["sellAveragePrice"] is None
    events = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={"scope": "invest", "ticker": "SYN.L", "start": DATES[0], "end": DATES[-1]},
    ).json()["data"]["items"]
    assert events == []


def test_unresolved_fill_is_disclosed_only_in_its_own_account_and_window(bound):
    app, _ = distinct_listing_events(bound)
    store = app.state.store
    rows = broker_markers([("SYN", "Market buy", 2, 30)])
    ref = store.immutable_artifacts.put_json(
        key=ins.TRADE_MARKERS, payload={"rows": rows, "calculation_version": "trade-markers-v3"}
    )
    manifest = republish(store, {ins.TRADE_MARKERS: ref})
    client = TestClient(app)
    for scope, end, expected in (
        ("isa", DATES[-1], True),
        ("invest", DATES[-1], False),
        ("isa", DATES[-2], False),
    ):
        result = client.get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"scope": scope, "ticker": "SYN.L", "start": DATES[0], "end": end},
        ).json()
        assert result["data"]["items"] == []
        assert ("trade_listing_unresolved" in result["quality"]["issues"]) == expected


def test_key_moments_attach_events_only_to_their_published_listing(bound):
    app, url = distinct_listing_events(bound)
    client = TestClient(app)
    query = {"start": DATES[0], "end": DATES[-1], "scope": "isa"}
    london = client.get(url, params={**query, "ticker": "SYN.L"}).json()
    assert london["data"]["ticker"] == "SYN.L"
    assert london["data"]["items"] == []
    assert "earnings_events_unavailable" in london["quality"]["issues"]
    london_chart = client.get("/v1/research/SYN.L/prices").json()
    assert london_chart["publishedSeriesId"] == london["data"]["published_series_id"]
    assert london_chart["tradeMarkers"] == []
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker="SYN", name="US listing", exchange="NYSE", bloomberg_ticker="", figi=""
        )
    )
    us = client.get(url, params={**query, "ticker": "SYN"}).json()
    us_chart = client.get("/v1/research/SYN/prices").json()
    assert us_chart["publishedSeriesId"] == us["data"]["published_series_id"]
    assert [marker["ticker"] for marker in us_chart["tradeMarkers"]] == ["SYN"]
    assert {(e["kind"], e["reference"]) for e in us["data"]["items"][0]["events"]} == {
        ("earnings", "US-earnings"),
        ("rating_change", "US-rating"),
        ("filing", "US-filing"),
        ("own_trade", "B"),
    }


def test_listing_news_and_dividends_only_reach_their_own_price_series(bound):
    app, _ = distinct_listing_events(bound)
    # Friday after the London close precedes both the US close and a weekend.
    friday, monday, tuesday = DATES[-3:]
    article = {
        "id": "provider-story",
        "title": "Synthetic company update",
        "publisher": "Test wire",
        "url": "https://example.test/story",
        "date": friday,
        "instant": friday + "T17:00:00Z",
    }
    store = app.state.store
    data = {
        NEWS_KEY: {"securities": {"SYN.L": {"items": [article]}}},
        NEWS_STATUS_KEY: {"securities": {"SYN.L": {"as_of": tuesday, "error": "TimeoutError"}}},
        tools.EARNINGS: {
            "rows": [
                {
                    "ticker": "SYN.L",
                    "calendar": {
                        "Ex-Dividend Date": friday,
                        "Dividend Date": tuesday,
                    },
                }
            ]
        },
        tools.FINANCIALS: {
            "rows": [
                {
                    "ticker": "SYN.L",
                    "financials": {
                        "evidence": {
                            "dividends": [{"date": friday, "amount": 0.25, "currency": "GBP"}],
                            "news": [
                                {
                                    "id": article["id"],
                                    "source": article["publisher"],
                                    "title": article["title"],
                                    "url": article["url"],
                                    "publishedAt": friday,
                                }
                            ],
                        }
                    },
                }
            ]
        },
    }
    manifest = republish(
        store, {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in data.items()}
    )
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker="SYN", name="US listing", exchange="NYSE", bloomberg_ticker="", figi=""
        )
    )
    client = TestClient(app)

    def reading(ticker):
        response = client.get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": tuesday},
        )
        assert response.status_code == 200
        return response.json()

    london = reading("SYN.L")
    dated = {item["date"]: item["events"] for item in london["data"]["items"]}
    assert {e["kind"] for e in dated[friday]} == {"ex_dividend"}
    assert dated[monday] == [
        {
            "kind": "news",
            "role": "lead",
            "reference": article["id"],
            "date": monday,
            "publication_date": friday,
        }
    ]
    assert [e["kind"] for e in dated[tuesday]] == ["dividend_pay"]
    assert "security_news_refresh_failed" in london["quality"]["issues"]
    us = reading("SYN")
    assert {e["kind"] for day in us["data"]["items"] for e in day["events"]}.isdisjoint(
        {"news", "dividend", "ex_dividend", "dividend_pay"}
    )
    assert {
        "security_news_unavailable",
        "dividends_unavailable",
        "security_calendar_unavailable",
    } <= set(us["quality"]["issues"])


def test_timed_news_requires_a_known_exchange_and_observes_early_closes(bound, monkeypatch):
    _, _, deps = bound
    ticker = "TEST"
    date = "2026-11-27"  # New York closes at 13:00 local after Thanksgiving.
    args = ins.MomentsArgs(scope="invest", ticker=ticker, start=date, end="2026-11-30")
    read = tools._Read(deps, "price_key_moments", args, args.scope)
    series = deps.price_series(ticker, deps.manifest)
    news = {
        "securities": {
            ticker: {
                "as_of": date,
                "items": [
                    {
                        "id": stamp,
                        "publisher": "Wire",
                        "title": "Synthetic headline",
                        "url": "https://example.test/" + stamp,
                        "date": date,
                        "instant": instant,
                    }
                    for stamp, instant in (
                        ("early", date + "T17:00:00Z"),
                        ("late", date + "T19:00:00Z"),
                        ("date-only", None),
                    )
                ],
            }
        }
    }
    monkeypatch.setattr(tools._Read, "read", lambda self, key: news if key == NEWS_KEY else None)

    def events(calendar):
        result, _, issues = ins.dated_events(
            read,
            args,
            set(),
            series.model_copy(
                update={
                    "exchange_calendar": calendar,
                    "published_bar_exchange": calendar,
                    "published_bar_mic": None,
                    "venue_claims": (),
                }
            ),
        )
        return {e["reference"]: e["date"] for e in result}, issues

    assert events("XNYS")[0] == {"early": date, "late": args.end, "date-only": date}
    dates, issues = events(None)
    assert dates == {"date-only": date}
    assert "listing_calendar_unavailable" in issues


def test_moment_news_references_fit_the_tool_limit_without_breaking_the_article_link(bound):
    import json

    app, _, _ = bound
    articles = [
        {
            "id": f"{day}-{n}" + "报" * 2000,
            "publisher": "Wire",
            "title": "Synthetic news",
            "url": f"https://example.test/{day}/{n}",
            "date": day,
        }
        for day in DATES[-3:]
        for n in range(6)
    ]
    store = app.state.store
    news = {"securities": {"TEST": {"as_of": DATES[-1], "items": articles}}}
    manifest = republish(
        store, {NEWS_KEY: store.immutable_artifacts.put_json(key=NEWS_KEY, payload=news)}
    )
    response = TestClient(app).get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={"ticker": "TEST", "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
    )
    data = response.json()
    assert len(json.dumps(data).encode()) <= tools.MAX_RESULT_BYTES
    assert data["status"] == "partial" and "result_byte_limit" in data["quality"]["issues"]
    moments = data["data"]["items"]
    assert len(moments) == 3 and all(m["events"] and m["event_count"] >= 6 for m in moments)
    references = {article["id"] for article in articles}
    assert all(
        e["reference"] in references for m in moments for e in m["events"] if e["kind"] == "news"
    )


def test_key_moment_evidence_changes_with_resolved_series(bound):
    app, url = distinct_listing_events(bound, london_report=True)
    client = TestClient(app)
    query = {"ticker": "SYN", "start": DATES[0], "end": DATES[-1], "scope": "isa"}
    london = client.get(url, params=query).json()
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker="SYN", name="US listing", exchange="NYSE", bloomberg_ticker="", figi=""
        )
    )
    us = client.get(url, params=query).json()
    assert london["data"]["items"][0]["move_fraction"] == pytest.approx(30 / 33 - 1)
    assert us["data"]["items"][0]["move_fraction"] == pytest.approx(40 / 30 - 1)
    assert us["data"]["published_series_id"] != london["data"]["published_series_id"]
    assert us["evidence_id"] != london["evidence_id"]
    assert client.get(url, params=query).json()["evidence_id"] == us["evidence_id"]


def test_broken_watchlist_only_withholds_listing_dependent_readings(bound):
    app, manifest, _ = bound
    client = TestClient(app, raise_server_exceptions=False)
    base = f"/v1/snapshots/{manifest.run_id}/insights/"
    queries = {
        "daily-returns": {"scope": "invest"},
        "dated-exposure": {
            "scope": "broker_total",
            "dimension": "country",
            "on_or_before": DATES[-1],
        },
    }
    before = {
        path: client.get(base + path, params=params).json() for path, params in queries.items()
    }
    watchlist = app.state.watchlist.path
    original = watchlist.read_bytes()
    watchlist.write_bytes(b'{"items":[')
    for path, params in queries.items():
        response = client.get(base + path, params=params)
        assert response.status_code == 200
        assert response.json() == before[path]
    params = {"scope": "isa", "ticker": "TEST", "start": DATES[0], "end": DATES[-1]}
    failed = client.get(base + "key-moments", params=params)
    assert failed.status_code == 200
    assert failed.json()["status"] == "unavailable" and failed.json()["data"] is None
    assert failed.json()["quality"]["reason_code"] == "published_daily_bars_unavailable"
    assert watchlist.read_bytes() == b'{"items":['
    watchlist.write_bytes(original)
    assert client.get(base + "key-moments", params=params).json()["data"]["items"]


def test_dated_gics_reports_holdings_classification_and_row_status(
    tmp_path, research_root, typed_fixture
):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    manifest = typed_fixture(research_root, store)
    artifacts = store.immutable_artifacts
    raw = store.read_json(manifest.run_id, tools.LOOKTHROUGH)
    raw.update(
        available=True,
        brokerAsOf=DATES[-1] + "T17:00:00Z",
        lookthroughCoveragePct=1,
        gicsCoveragePct=0.2,
        gicsPortfolioCoveragePct=0.15,
        gicsSubIndustryAllocation=[
            {
                "subIndustry": "Software",
                "subIndustryCode": "45103010",
                "classificationStatus": "classified",
                "valueGbp": 15,
                "allocationPct": 0.15,
            },
            {
                "subIndustry": "Unknown",
                "classificationStatus": "pending-identity",
                "valueGbp": 60,
                "allocationPct": 0.6,
            },
            {
                "subIndustry": "Other",
                "classificationStatus": "not-applicable",
                "valueGbp": 25,
                "allocationPct": 0.25,
            },
        ],
    )
    refs = {}
    current = artifacts.put_json(key=tools.LOOKTHROUGH, payload=raw)
    record_exposure(artifacts, refs, current.ref)
    manifest = republish(store, {tools.LOOKTHROUGH: current, **refs})
    holdings = build_dashboard_data(store, manifest)["lookthrough"]
    response = TestClient(app).get(
        f"/v1/snapshots/{manifest.run_id}/insights/dated-exposure",
        params={"scope": "broker_total", "dimension": "gics", "on_or_before": DATES[-1]},
    )
    reading = response.json()
    assert reading["status"] == "partial"
    assert (
        reading["data"]["lookthrough_coverage_fraction"] == holdings["lookthroughCoveragePct"] == 1
    )
    assert reading["data"]["gics_coverage_fraction"] == holdings["gicsCoveragePct"] == 0.2
    assert reading["data"]["gics_portfolio_coverage_fraction"] == 0.15
    assert {row["classification_status"] for row in reading["data"]["items"]} == {
        "classified",
        "pending-identity",
        "not-applicable",
    }

    current_reading = _call(
        app.state.assistant.deps_for_run(None, None),
        tools.lookthrough_exposure,
        tools.ExposureArgs(scope="broker_total", dimension="gics"),
    )
    assert current_reading["status"] == reading["status"]
    for field in (
        "lookthrough_coverage_fraction",
        "gics_coverage_fraction",
        "gics_portfolio_coverage_fraction",
        "items",
    ):
        assert current_reading["data"][field] == reading["data"][field]


def test_exposure_storage_coalesces_repeated_publications_and_preserves_pins(tmp_path):
    import sqlite3

    from trading_max.backup_repository import BackupRepository
    from trading_max.storage_budget import usage

    store = ArtifactStore(tmp_path / "state")
    sqlite3.connect(store.data_root / "trading_max.db").close()
    artifacts = store.immutable_artifacts
    refs = {}
    first = None
    backup = BackupRepository(tmp_path / "backup")
    country = [
        {"country": f"Country {i}", "valueGbp": i, "allocationPct": i / 10000} for i in range(150)
    ]
    gics = [
        {
            "subIndustry": f"Industry {i}",
            "valueGbp": i,
            "allocationPct": i / 10000,
            "classificationStatus": "classified",
        }
        for i in range(163)
    ]

    source_bytes = 0
    early_ids = []
    for day in range(120):
        for observation in range(4):
            stamp = datetime(2026, 1, 1, 8, tzinfo=UTC) + timedelta(days=day, hours=observation)
            raw = {
                "available": True,
                "brokerAsOf": stamp.isoformat(),
                "countryAllocation": country,
                "gicsSubIndustryAllocation": gics,
            }
            current = artifacts.put_json(key=tools.LOOKTHROUGH, payload=raw)
            source_bytes += current.path.stat().st_blocks * 512
            record_exposure(artifacts, refs, current.ref)
            key = f"{PREFIX}{stamp.date().isoformat()}.json"
            if day == 0:
                early_ids.append(refs[key].artifact_id)
            snapshot = store.immutable_snapshots.publish(
                scope="all",
                source="synthetic",
                artifacts=[current, *refs.values()],
                created_at=stamp,
            )
            if first is None:
                first = snapshot.manifest.run_id
                receipt = backup.create(store.data_root)
    assert len(set(early_ids)) == 1
    assert len(refs) == 37
    assert usage({"artifacts": artifacts.root})["allocatedBytes"] == source_bytes
    # Include all 480 immutable manifests, even the ones outside the latest window.
    assert usage({"state": store.data_root})["allocatedBytes"] - source_bytes < 12 * 1024 * 1024
    assert store.read_json(first, PREFIX + "2026-01-01.json")["brokerAsOf"].startswith(
        "2026-01-01T08"
    )
    assert PREFIX + "2026-01-01.json" not in refs
    restored_root = tmp_path / "restored"
    assert backup.restore(receipt["id"], restored_root)["snapshotRunId"] == first
    restored = ArtifactStore(restored_root)
    assert restored.read_json(first, PREFIX + "2026-01-01.json") == store.read_json(
        first, PREFIX + "2026-01-01.json"
    )


def daily_csv_result(bound, text):
    app, _, _ = bound
    store = app.state.store
    key = tools.HISTORY_KEYS[0]
    republish(
        store,
        {
            key: store.immutable_artifacts.put_bytes(
                key=key, content=text.encode(), media_type="text/csv"
            )
        },
    )
    return ins.daily_data(
        app.state.assistant.deps_for_run(None, None), ins.DailyArgs(scope="invest", range="ALL")
    )


def test_withdrawal_and_redeposit_do_not_rank_undefined_daily_returns(bound):
    reading = daily_csv_result(
        bound,
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,DailyReturn,TWRWealth\n"
        "2026-01-28,100,0,0,,1\n"
        "2026-01-29,110,0,0,0.1,1.1\n"
        "2026-01-30,0,-110,-110,,\n"
        "2026-02-02,100,100,0,,\n"
        "2026-02-03,105,0,0,0.05,1.155\n",
    )
    assert reading["status"] == "partial"
    assert [r["date"] for r in reading["data"]["items"]] == ["2026-02-03", "2026-01-29"]
    assert [r["return_fraction"] for r in reading["data"]["items"]] == pytest.approx([0.05, 0.1])


def test_daily_ranks_tie_at_published_return_precision(bound):
    reading = daily_csv_result(
        bound,
        "Date,SyntheticNAVGBP,ExternalFlowGBP,TWRWealth\n"
        "2026-01-28,100,0,1.00\n2026-01-29,110,0,1.10\n2026-01-30,121,0,1.21\n",
    )
    assert [r["worst_rank"] for r in reading["data"]["items"]] == [1, 1]


def test_relative_daily_range_uses_returns_lens_calendar(bound):
    app, manifest, _ = bound
    store = app.state.store
    key = tools.HISTORY_KEYS[2]
    csv = store.read_text(manifest.run_id, key) + "2026-02-08,20,100,100,-80\n"
    manifest = republish(
        store,
        {
            key: store.immutable_artifacts.put_bytes(
                key=key, content=csv.encode(), media_type="text/csv"
            )
        },
    )
    history = HistoryReader(store).read(manifest, "1W", "invest")
    chart = benchmark_comparison(
        in_range([p.model_dump(mode="json") for p in history.nav], "1W"),
        "invest",
        store.read_json(manifest.run_id, tools.TECHNICAL)["benchmark_series"],
        ["VOO"],
    )
    assert [p["date"] for p in chart["points"]] == DATES[-2:]
    result = ins.daily_data(
        app.state.assistant.deps_for_run(None, None), ins.DailyArgs(scope="invest", range="1W")
    )
    assert [(row["from_date"], row["date"]) for row in result["data"]["items"]] == [
        tuple(DATES[-2:])
    ]


@pytest.mark.parametrize(("requested", "published"), [("SYN", "SYN.L"), ("SYN.L", "SYN")])
@pytest.mark.parametrize(
    ("us", "london"), [("NYSE", "LSE"), ("UN", "LN"), ("US", "LN"), ("US", "US")]
)
def test_missing_chart_cannot_borrow_a_known_other_venue(
    bound, monkeypatch, requested, published, us, london
):
    app, _ = distinct_listing_events(bound, london_report=True)
    store = app.state.store
    technical = store.read_json(store.latest_manifest().run_id, tools.TECHNICAL)
    technical["rows"] = [row for row in technical["rows"] if row["ticker"] == published]
    manifest = republish(
        store,
        {
            tools.TECHNICAL: store.immutable_artifacts.put_json(
                key=tools.TECHNICAL, payload=technical
            )
        },
    )
    app.state.watchlist.remove("SYN.L")
    for symbol, venue in [("SYN", us), ("SYN.L", london)]:
        app.state.watchlist.add(
            SecuritySearchResult(
                ticker=symbol, name="Synthetic", exchange=venue, bloomberg_ticker="", figi=""
            )
        )

    def missing_live(symbol, *args, **kwargs):
        assert symbol == requested
        raise ValueError("synthetic missing bars")

    monkeypatch.setattr(app.state.security_prices, "get", missing_live)
    client = TestClient(app)
    assert client.get(f"/v1/research/{published}/prices").json()["points"]
    missing = client.get(f"/v1/research/{requested}/prices")
    assert missing.status_code == 404
    result = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={"ticker": requested, "scope": "invest", "start": DATES[0], "end": DATES[-1]},
    ).json()
    assert (
        result["data"] is None
        and result["quality"]["reason_code"] == "published_daily_bars_unavailable"
    )


@pytest.mark.parametrize("disclosure", [None, "history", "ex_date"])
def test_fund_bar_distribution_qualifies_once_on_its_own_listing(bound, monkeypatch, disclosure):
    app, initial, _ = bound
    store = app.state.store
    date = DATES[-1]
    points = store.read_json(initial.run_id, tools.TECHNICAL)["rows"][0]["price_series"]
    points[-1]["dividend"] = 0.5
    data = {
        FUND_PRICES_KEY: {"rows": [{"ticker": "SPY", "currency": "USD", "price_series": points}]}
    }
    if disclosure == "history":
        data[tools.FINANCIALS] = {
            "rows": [
                {
                    "ticker": "SPY",
                    "financials": {
                        "evidence": {
                            "dividends": [{"date": date, "amount": 0.5, "currency": "USD"}]
                        }
                    },
                }
            ]
        }
    elif disclosure == "ex_date":
        data[tools.EARNINGS] = {"rows": [{"ticker": "SPY", "calendar": {"Ex-Dividend Date": date}}]}
    manifest = republish(
        store, {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in data.items()}
    )
    monkeypatch.setattr(app.state.security_prices, "alpaca_etf", lambda *args: None)
    client = TestClient(app)
    chart = client.get("/v1/research/SPY/prices").json()
    assert chart["events"] == [{"date": date, "kind": "dividend", "value": 0.5, "currency": "USD"}]
    result = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={
            "ticker": "SPY",
            "scope": "cfd",
            "start": DATES[0],
            "end": date,
            "published_series_id": chart["publishedSeriesId"],
        },
    ).json()
    (moment,) = result["data"]["items"]
    assert moment["date"] == date and moment["move_fraction"] != 0
    assert moment["event_count"] == 1
    assert [event["kind"] for event in moment["events"]] == [
        "ex_dividend" if disclosure == "ex_date" else "dividend"
    ]


@pytest.mark.parametrize(
    ("venue", "session"), [("FRA", "2026-01-30"), ("GER", "2026-02-02"), ("UNVERIFIED", None)]
)
def test_evening_headline_uses_observed_german_venue(bound, venue, session):
    app, initial, _ = bound
    store = app.state.store
    ticker = "SYN"
    friday = DATES[-3]
    technical = store.read_json(initial.run_id, tools.TECHNICAL)
    technical["rows"] = [
        {**technical["rows"][0], "ticker": ticker, "exchange": venue, "timezone": "Europe/Berlin"}
    ]
    article = {
        "id": "friday",
        "title": "Synthetic update",
        "publisher": "Wire",
        "url": "https://example.test/friday",
        "date": friday,
        "instant": friday + "T18:00:00Z",
    }
    payloads = {
        tools.TECHNICAL: technical,
        NEWS_KEY: {"securities": {ticker: {"items": [article], "as_of": friday}}},
        tools.FUNDAMENTALS: {
            "rows": [
                {
                    "ticker": ticker,
                    "metrics": {
                        "fullExchangeName": "Frankfurt" if venue == "FRA" else "XETRA",
                        "exchangeTimezoneName": "Europe/Berlin",
                    },
                }
            ]
        },
    }
    manifest = republish(
        store,
        {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in payloads.items()},
    )
    reading = (
        TestClient(app)
        .get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
        )
        .json()
    )
    dates = [
        e["date"] for day in reading["data"]["items"] for e in day["events"] if e["kind"] == "news"
    ]
    assert dates == ([session] if session else [])
    assert ("listing_calendar_unavailable" in reading["quality"]["issues"]) == (session is None)


@pytest.mark.parametrize(
    ("symbol", "name"),
    [
        ("SYN", "NYSE"),
        ("SYN.L", "LSE"),
        ("SYN", "Irish"),
        ("SYN", "Taiwan"),
        ("SYN", "KSE"),
        ("SYN.IR", None),
        ("SYN.TW", None),
        ("SYN.KS", None),
        ("SYN.VI", "UNVERIFIED"),
    ],
)
def test_legacy_venue_names_and_qualified_symbols_align_timed_leads(bound, symbol, name):
    app, initial, _ = bound
    store = app.state.store
    friday = DATES[-3]
    rows = store.read_json(initial.run_id, tools.TECHNICAL)["rows"]
    article = {
        "id": "story",
        "title": "Synthetic update",
        "publisher": "Wire",
        "url": "https://example.test/update",
        "date": friday,
        "instant": friday + "T04:00:00Z",
    }
    payloads = {
        tools.TECHNICAL: {"rows": [{**rows[0], "ticker": symbol, "exchange": None}]},
        tools.FUNDAMENTALS: {"rows": [{"ticker": symbol, "metrics": {"fullExchangeName": name}}]},
        NEWS_KEY: {"securities": {symbol: {"items": [article], "as_of": friday}}},
    }
    manifest = republish(
        store,
        {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in payloads.items()},
    )
    reading = (
        TestClient(app)
        .get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"ticker": symbol, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
        )
        .json()
    )
    events = [e for day in reading["data"]["items"] for e in day["events"] if e["kind"] == "news"]
    if name == "UNVERIFIED":
        assert not events and "listing_calendar_unavailable" in reading["quality"]["issues"]
    else:
        assert [(e["date"], e["role"]) for e in events] == [(friday, "lead")]


@pytest.mark.parametrize(
    ("mic", "kind", "day", "after", "before", "inside", "late"),
    [
        (
            "XHKG",
            "EQUITY",
            "2026-01-30",
            "2026-02-02",
            "16:04:00+08:00",
            "16:09:00+08:00",
            "16:10:01+08:00",
        ),
        (
            "XHKG",
            "ETF",
            "2026-12-24",
            "2026-12-28",
            "12:04:00+08:00",
            "12:09:00+08:00",
            "12:10:01+08:00",
        ),
        (
            "XWBO",
            "EQUITY",
            "2026-01-30",
            "2026-02-02",
            "17:32:00+01:00",
            "17:35:15+01:00",
            "17:35:31+01:00",
        ),
        (
            "XWBO",
            "ETF",
            "2026-01-30",
            "2026-02-02",
            "17:31:59+01:00",
            "17:32:15+01:00",
            "17:32:31+01:00",
        ),
    ],
)
def test_headlines_disclose_closing_auction_uncertainty(
    bound, monkeypatch, mic, kind, day, after, before, inside, late
):
    _, _, deps = bound
    args = ins.MomentsArgs(scope="invest", ticker="TEST", start=day, end=after)
    read = tools._Read(deps, "price_key_moments", args, args.scope)
    series = deps.price_series("TEST", deps.manifest).model_copy(
        update={
            "exchange_calendar": mic,
            "published_bar_exchange": mic,
            "venue_claims": (),
            "published_bar_segment": "prime market" if kind == "EQUITY" else "ETF2",
        }
    )
    news = {
        "securities": {
            "TEST": {
                "as_of": day,
                "items": [
                    {
                        "id": key,
                        "title": key,
                        "url": "https://example.test/" + key,
                        "publisher": "Wire",
                        "date": day,
                        "instant": day + "T" + stamp,
                    }
                    for key, stamp in (("before", before), ("inside", inside), ("late", late))
                ],
            }
        }
    }
    data = {
        NEWS_KEY: news,
        tools.FUNDAMENTALS: {"rows": [{"ticker": "TEST", "metrics": {"quoteType": kind}}]},
    }
    monkeypatch.setattr(tools._Read, "read", lambda self, key: data.get(key))
    events, _, _ = ins.dated_events(read, args, set(), series)
    assert {
        e["reference"]: (e["date"], e.get("timing"), e["role"])
        for e in events
        if e["kind"] == "news"
    } == {
        "before": (day, None, "lead"),
        "inside": (day, "closing_auction_window", "lead"),
        "late": (after, None, "lead"),
    }


@pytest.mark.parametrize(
    ("published", "fundamental", "expected"),
    [
        ("ETF", None, True),
        (None, "ETF", True),
        (None, "MUTUALFUND", False),
        ("ETF", "MUTUALFUND", False),
        ("MUTUALFUND", "ETF", False),
        (None, None, False),
    ],
)
@pytest.mark.parametrize("metadata", ["metrics", "info"])
def test_pinned_fund_auction_uses_verified_product(
    bound, published, fundamental, expected, metadata
):
    app, initial, _ = bound
    store = app.state.store
    day = DATES[-3]
    ticker = "SYN"
    points = store.read_json(initial.run_id, tools.TECHNICAL)["rows"][0]["price_series"]
    article = {
        "id": "vienna-fund",
        "title": "Fund update",
        "publisher": "Wire",
        "url": "https://example.test/fund",
        "date": day,
        "instant": day + "T16:32:15Z",
    }
    payloads = {
        FUND_PRICES_KEY: {
            "rows": [
                {
                    "ticker": ticker,
                    "currency": "EUR",
                    "mic": "XWBO",
                    "asset_type": published,
                    "market_segment": "ETF2",
                    "price_series": points,
                }
            ]
        },
        tools.FUNDAMENTALS: {"rows": [{"ticker": ticker, metadata: {"quoteType": fundamental}}]},
        NEWS_KEY: {"securities": {ticker: {"items": [article], "as_of": day}}},
    }
    manifest = republish(
        store,
        {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in payloads.items()},
    )
    reading = (
        TestClient(app)
        .get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
        )
        .json()
    )
    events = [event for row in reading["data"]["items"] for event in row["events"]]
    if not expected:
        assert not events and "listing_calendar_unavailable" in reading["quality"]["issues"]
        return
    assert events == [
        {
            "date": day,
            "kind": "news",
            "role": "lead",
            "reference": "vienna-fund",
            "timing": "closing_auction_window",
        }
    ]


@pytest.mark.parametrize(
    ("ticker", "row", "metrics"),
    [
        ("SYN", {"mic": "XNYS", "exchange": "LSE"}, {}),
        ("SYN.F", {}, {"fullExchangeName": "XETRA"}),
    ],
)
def test_conflicting_pinned_claims_block_chart_and_lead(bound, monkeypatch, ticker, row, metrics):
    app, initial, _ = bound
    store = app.state.store
    day = DATES[-3]
    base = store.read_json(initial.run_id, tools.TECHNICAL)["rows"][0]
    article = {
        "id": "lead",
        "title": "Synthetic",
        "publisher": "Wire",
        "date": day,
        "url": "https://example.test/lead",
        "instant": day + "T18:00:00Z",
    }
    payloads = {
        tools.TECHNICAL: {"rows": [{**base, "ticker": ticker, "exchange": None, **row}]},
        tools.FUNDAMENTALS: {"rows": [{"ticker": ticker, "metrics": metrics}]},
        NEWS_KEY: {"securities": {ticker: {"items": [article], "as_of": day}}},
    }
    manifest = republish(
        store,
        {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in payloads.items()},
    )
    client = TestClient(app)
    monkeypatch.setattr(
        app.state.security_prices,
        "get",
        lambda *a, **kw: pytest.fail("conflict attempted live fallback"),
    )
    result = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
    ).json()
    assert "listing_calendar_unavailable" in result["quality"]["issues"]
    from services.api.trading_max_api.agent.events import EventArgs, event_data

    deps = app.state.assistant.deps_for_run(None, None)
    for upcoming in (True, False):
        calendar = event_data(
            deps,
            EventArgs(scope="cfd", ticker=ticker, start=DATES[0], end=DATES[-1]),
            upcoming=upcoming,
        )
        assert "listing_calendar_unavailable" in calendar["quality"]["issues"]
        assert not any(
            e["kind"] in {"news", "dividend", "dividend_pay", "ex_dividend"}
            for e in calendar["data"]["items"]
        )
    assert client.get(f"/v1/research/{ticker}/prices").status_code == 404


def test_held_fund_route_preserves_original_requested_listing(bound, monkeypatch):
    from trading_max.research.held_funds import FundListingIdentity

    app, initial, _ = bound
    store = app.state.store
    points = store.read_json(initial.run_id, tools.TECHNICAL)["rows"][0]["price_series"]
    key = FUND_PRICES_KEY
    fund = FundListingIdentity("SYNTH", "XLON", "SYN", "SYN.L", "LSE")
    monkeypatch.setattr(app.state.research, "_held_funds", lambda m: {fund: {}})
    republish(
        store,
        {
            key: store.immutable_artifacts.put_json(
                key=key,
                payload={
                    "rows": [
                        {
                            "ticker": "SYN.L",
                            "isin": "SYNTH",
                            "mic": "XLON",
                            "exchange": "LSE",
                            "currency": "GBP",
                            "price_series": points,
                        }
                    ]
                },
            )
        },
    )
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker="SYN", name="Synthetic", exchange="UN", bloomberg_ticker="", figi=""
        )
    )

    def missing(ticker, *a, **kw):
        assert ticker == "SYN"
        raise ValueError("no synthetic bars")

    monkeypatch.setattr(app.state.security_prices, "get", missing)
    client = TestClient(app)
    assert client.get("/v1/research/SYN.L/prices").status_code == 200
    assert client.get("/v1/research/SYN/prices").status_code == 404


@pytest.mark.parametrize("upcoming", [True, False])
def test_news_diagnostics_cannot_overwrite_the_feeds_listing(bound, upcoming):
    from services.api.trading_max_api.agent.events import EventArgs, event_data

    app, _, _ = bound
    store = app.state.store
    ticker = "SYN"
    date = DATES[-3]
    source = {"ticker": ticker, "mic": "XLON", "as_of": date, "items": []}
    status = {"ticker": ticker, "mic": "XNYS", "as_of": date}
    publications = {
        NEWS_KEY: {"securities": {ticker: source}},
        NEWS_STATUS_KEY: {"securities": {ticker: status}},
        tools.EARNINGS: {"rows": [{"ticker": ticker, "calendar": {"Ex-Dividend Date": date}}]},
    }
    republish(
        store,
        {k: store.immutable_artifacts.put_json(key=k, payload=v) for k, v in publications.items()},
    )
    result = event_data(
        app.state.assistant.deps_for_run(None, None),
        EventArgs(scope="cfd", ticker=ticker, start=DATES[0], end=DATES[-1]),
        upcoming=upcoming,
    )
    assert "listing_calendar_unavailable" in result["quality"]["issues"]
    assert not any(row.get("ticker") == ticker for row in result["data"]["items"])
