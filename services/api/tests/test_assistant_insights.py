"""Each read agrees with its published page inputs and stays inside its pinned scope."""

from dataclasses import replace
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from trading_max.analytics.exposure_history import PREFIX, record_exposure, retained_dates
from trading_max.analytics.key_moments import key_moments
from trading_max.portfolio_math import benchmark_comparison, in_range, period_return

from services.api.tests.assistant_fixture import DATES, publication
from services.api.trading_max_api.agent import insights as ins
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.dashboard import build_dashboard_data
from services.api.trading_max_api.history_reader import HistoryReader


@pytest.fixture
def bound(tmp_path):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    manifest = publication(store)
    return app, manifest, AssistantDepsFactory(store).for_run()


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


def test_exposure_retains_last_observation_month_ends_and_recent_dates(bound):
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
    assert sample["brokerAsOf"] == "2026-07-01T14:00:00Z"
    assert len(sample["positions"]) == 40 and sample["positions"][0]["name"] == "49"
    assert ins.exposure_rows(sample, "country") == [
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
                    "fills": [
                        {"account": "invest", "side": "buy"},
                        {"account": "isa", "side": "sell"},
                    ],
                }
            ]
        },
    }
    for scope, marker in (("invest", "B"), ("isa", "S"), ("broker_total", "T")):
        args = ins.MomentsArgs(scope=scope, ticker="TEST", start=DATES[0], end=day)
        reader = tools._Read(deps, "price_key_moments", args, scope)
        monkeypatch.setattr(tools._Read, "read", lambda self, key: docs.get(key))
        events, _, issues = ins.dated_events(reader, args, reader.account_codes(scope))
        assert not issues
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

    result = habits()
    assert result["buy"] == {
        "side": "buy",
        "decisions": 3,
        "evaluated": 2,
        "favourable": 1,
        "adverse": 0,
        "unchanged": 1,
        "favourable_fraction": 0.5,
        "effect_gbp": 8,
    }
    assert result["sell"]["effect_gbp"] == -3
    assert habits(horizon="20_sessions")["sell"]["effect_gbp"] is None
    assert habits(horizon="to_date")["buy"]["effect_gbp"] == 10
    assert habits(since=DATES[2])["buy"]["favourable_fraction"] == 0
