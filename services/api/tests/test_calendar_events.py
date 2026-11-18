"""Assert source-backed chronology over historical publications and account boundaries."""

from dataclasses import replace
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from trading_max.research.calendars.refresh import MACRO_KEY
from trading_max.research.news import NEWS_KEY

from services.api.trading_max_api.agent import events
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore


def publish(store, headline="Synthetic release", *, eps_currency="USD", markers=None):
    from trading_max.research.analyst_evidence import earnings_events

    normalised = earnings_events(
        [
            {
                "Earnings Date": "2026-11-25",
                "EPS Estimate": 1.2,
                "Reported EPS": 1.0,
                "EPS Currency": eps_currency,
                "Fiscal Quarter Ending": "2026-09-30",
            }
        ],
        timezone="America/New_York",
        observed_at="2026-11-26T00:00:00Z",
    )
    raw = {
        "id": "provider-article",
        "title": headline,
        "publisher": "Fixture Press",
        "url": "https://example.org/article",
        "instant": "2026-11-26T00:30:10Z",
    }
    payloads = {
        NEWS_KEY: {
            "securities": {
                "ALFA": {"items": [raw], "as_of": "2026-11-26"},
                "BETA": {
                    "items": [{**raw, "url": raw["url"] + "?via=beta"}],
                    "as_of": "2026-11-26",
                },
                "WATCH": {"items": [], "as_of": "2026-11-26"},
            }
        },
        events.ANALYST: {
            "rows": [
                {
                    "ticker": "ALFA",
                    "analyst": {
                        "earningsEvents": normalised,
                        "reportingCurrency": "USD",
                        "upgradesDowngrades": [
                            {
                                "Firm": "Fixture Broker",
                                "GradeDate": "2026-11-25T11:53:22",
                                "Action": "down",
                                "ToGrade": "neutral",
                            }
                        ],
                    },
                }
            ]
        },
        events.EARNINGS: {
            "rows": [
                {
                    "ticker": "WATCH",
                    "calendar": {
                        "Earnings Date": ["2026-11-26", "2026-11-27"],
                        "Ex-Dividend Date": "2026-11-26",
                        "Dividend Date": "2026-11-30",
                    },
                }
            ]
        },
        events.TECHNICAL: {
            "rows": [
                {"ticker": t, "exchange": "NMS", "timezone": "America/New_York"}
                for t in ["ALFA", "BETA", "WATCH"]
            ]
        },
        events.FINANCIALS: {
            "rows": [
                {
                    "ticker": "ALFA",
                    "financials": {
                        "evidence": {
                            "filings": [
                                {
                                    "date": "2026-11-25",
                                    "form": "10-Q",
                                    "title": "Synthetic disclosure",
                                    "url": "https://example.org/filing",
                                }
                            ],
                            "news": [
                                {
                                    "title": headline,
                                    "source": "Fixture Press",
                                    "url": raw["url"],
                                    "publishedAt": raw["instant"],
                                }
                            ],
                            "dividends": [
                                {
                                    "date": "2026-11-25",
                                    "amount": 1.5,
                                    "currency": "USD",
                                    "basis": "provider-adjusted-per-share",
                                }
                            ],
                        }
                    },
                }
            ]
        },
        events.MARKERS: {
            "rows": markers
            if markers is not None
            else [
                {
                    "ticker": "ALFA",
                    "fills": [
                        {
                            "at": "2026-11-25T13:00:00Z",
                            "account": "invest",
                            "side": "buy",
                            "quantity": 1,
                        },
                        {
                            "at": "2026-11-25T14:00:00Z",
                            "account": "isa",
                            "side": "sell",
                            "quantity": 2,
                            "listing": "LSE:ALFA",
                        },
                    ],
                }
            ]
        },
        "account/broker_snapshot_metrics.json": {
            "accounts": {
                code: {"positions": [{"ticker": ticker}]}
                for code, ticker in [("A", "ALFA"), ("B", "BETA")]
            }
        },
        MACRO_KEY: {
            "sources": {
                "hk": {
                    "as_of": "2026-11-25T00:00:00Z",
                    "events": [
                        {
                            "id": "calendar-observation",
                            "market": "HK",
                            "publisher": "C&SD",
                            "title_en": "Consumer prices",
                            "title_zh": "消费者价格",
                            "date": "2026-11-26",
                            "instant": None,
                            "timezone": "Asia/Hong_Kong",
                            "source_url": "https://example.org/calendar",
                            "credit": "C&SD",
                            "status": "provisional",
                        }
                    ],
                }
            }
        },
    }
    return store.publish_typed(
        scope="research",
        source="synthetic",
        artifacts=[
            store.immutable_artifacts.put_json(key=k, payload=v) for k, v in payloads.items()
        ],
    )


def args(scope="household", **kw):
    return events.EventArgs(scope=scope, start="2026-11-25", end="2026-11-30", limit=20, **kw)


def test_news_and_trades_are_snapshot_and_account_bound(tmp_path):
    store = ArtifactStore(tmp_path)
    old = publish(store)
    deps = AssistantDepsFactory(store).for_run(timezone="America/New_York")
    publish(store, "Newer synthetic headline", eps_currency=None)
    result = events.event_data(deps, args("invest"), upcoming=False)
    rows = result["data"]["items"]
    revised = events.event_data(
        AssistantDepsFactory(store).for_run(), args("invest"), upcoming=False
    )
    missing = next(r for r in revised["data"]["items"] if r["kind"] == "earnings")
    assert missing["currency"] is missing["estimated_eps"] is missing["actual_eps"] is None
    assert "earnings_currency_unavailable" in revised["quality"]["issues"]
    assert result["snapshot_id"] == old.run_id and "leads" in result["data"]["news_basis"]
    assert all(row["evidence_id"].startswith("ev_") for row in rows)
    (headline,) = [r for r in rows if r["kind"] == "news"]
    assert (headline["title_en"], headline["local_date"], headline["role"]) == (
        "Synthetic release",
        "2026-11-25",
        "lead",
    )
    (fill,) = [r for r in rows if r["kind"] == "own_trade"]
    assert fill["account"] == "invest" and fill["quantity"] == 1
    earnings = next(r for r in rows if r["kind"] == "earnings")
    assert earnings["fiscal_period"] == "2026-09-30"
    assert earnings["source_as_of"] == "2026-11-26T00:00:00Z"
    assert (earnings["estimated_eps"], earnings["actual_eps"], earnings["currency"]) == (
        1.2,
        1.0,
        "USD",
    )
    assert {r["kind"] for r in rows} == {
        "earnings",
        "dividend",
        "filing",
        "own_trade",
        "news",
        "rating_change",
    }
    assert (
        next(r for r in rows if r["kind"] == "rating_change")["instant"]
        == "2026-11-25T11:53:22+00:00"
    )
    household = events.event_data(deps, args(), upcoming=False)
    (story,) = [r for r in household["data"]["items"] if r["kind"] == "news"]
    assert story["tickers"] == ["ALFA", "BETA"]
    assert story["evidence_id"] == headline["evidence_id"]
    london = events.event_data(deps, args("isa", ticker="ALFA.L"), upcoming=False)
    assert [r["side"] for r in london["data"]["items"] if r["kind"] == "own_trade"] == ["sell"]
    with pytest.raises(ModelRetry):
        events.event_data(
            replace(deps, allowed_scopes=frozenset({"isa"})), args("invest"), upcoming=False
        )


def test_pinned_api_calendar_dates_and_early_close(tmp_path):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    manifest = publish(store)
    url = f"/v1/snapshots/{manifest.run_id}/events/upcoming"
    query = args().model_dump(exclude_none=True)
    with TestClient(app) as client:
        resp = client.get(url, params={**query, "timezone": "America/Los_Angeles"})
        assert resp.status_code == 200, resp.text
        result = resp.json()
        rows = result["data"]["items"]
        hk = next(r for r in rows if r["kind"] == "macro")
        assert hk["local_date"] == "2026-11-26" and hk["local_time"] is None
        assert next(r for r in rows if r["kind"] == "holiday")["date"] == "2026-11-26"
        half = next(r for r in rows if r["kind"] == "half_day")
        assert half["local_time"] == "2026-11-27T10:00:00-08:00"
        watch = [r for r in rows if r.get("ticker") == "WATCH"]
        assert {r["kind"] for r in watch} == {"earnings", "ex_dividend", "dividend_pay"}
        assert next(r for r in watch if r["kind"] == "earnings")["end_date"] == "2026-11-27"
        assert client.get(url, params={**query, "end": "2029-01-01"}).status_code == 422
        assert client.get(url, params={**query, "timezone": "unknown/zone"}).status_code == 422
        assert client.get(url.replace(manifest.run_id, "absent"), params=query).status_code == 404
        local = client.get(url, params={**query, "limit": 1}).json()
        assert (
            local["data"]["timezone"] == ZoneInfo("Europe/London").key
            and local["data"]["next_cursor"] == 1
        )
        assert {"news", "macro"} == {
            r["kind"] for r in client.get("/health").json()["eventRefreshes"]
        }


def test_conflicting_fill_instrument_does_not_match_exact_listing(tmp_path):
    import pandas as pd
    from trading_max.analytics.ledger import transaction_marker_rows

    tx = pd.DataFrame(
        [
            {
                "Action": "Market buy",
                "Time": pd.Timestamp("2026-11-25T10:00:00Z"),
                "ISIN": "GB0000000001",
                "Ticker": symbol,
                "Shares": 1,
                "PriceN": 10,
                "TotalN": 10,
                "Currency (Total)": "GBP",
            }
            for symbol in ["ALFA", "ALFAl_EQ"]
        ]
    )
    markers = transaction_marker_rows(
        {"invest": tx}, [{"ticker": "ALFA", "broker_ticker": "ALFA_US_EQ", "isin": "US0000000001"}]
    )
    store = ArtifactStore(tmp_path)
    publish(store, markers=markers)
    deps = AssistantDepsFactory(store).for_run()

    def trades(ticker=None):
        result = events.event_data(deps, args("invest", ticker=ticker), upcoming=False)
        return [r for r in result["data"]["items"] if r["kind"] == "own_trade"], result["quality"][
            "issues"
        ]

    all_rows, _ = trades()
    assert len(all_rows) == 2
    empty, issues = trades("ALFA")
    assert empty == [] and "trade_listing_unresolved" in issues
    (london,), _ = trades("ALFA.L")
    assert london["ticker"] == "ALFA.L"


def test_later_revision_and_cancellation_supersede_outside_window():
    row = {
        "date": "2026-11-20",
        "id": "release",
        "publisher": "ONS",
        "title_en": "Retail",
        "status": "finalised",
    }
    for status in ("cancelled", "finalised"):
        payload = {
            "sources": {
                "old": {"as_of": "2026-11-17T12:00:00Z", "events": [row]},
                "new": {
                    "as_of": "2026-11-18T12:00:00Z",
                    "events": [{**row, "status": status, "date": "2026-11-25"}],
                },
            }
        }
        assert events._macros(payload, "2026-11-19", "2026-11-21", []) == []
        assert events._macros(payload, "2026-11-25", "2026-11-25", [])[0]["status"] == status


def test_ons_month_precision_licence_and_failed_partition_reach_api_and_agent(tmp_path):
    from datetime import UTC, date, datetime
    from pathlib import Path

    from trading_max.domain import ArtifactQuality
    from trading_max.research.calendars.catalog import sources
    from trading_max.research.calendars.refresh import MACRO_STATUS_KEY, refresh_calendar

    fixture = (
        Path(__file__).resolve().parents[3] / "backend/tests/fixtures/calendars/ons-precision.json"
    )
    publishers = [s for s in sources(date(2026, 11, 18)) if s.parser == "ons"]

    def fetch(url):
        if "type-cancelled" in url:
            raise ValueError("unavailable")
        return fixture.read_bytes()

    clock = datetime(2026, 11, 18, 11, tzinfo=UTC)
    calendar = refresh_calendar({}, clock, fetch, catalog=lambda _: publishers)
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    ref = store.immutable_artifacts.put_json(key=MACRO_KEY, payload=calendar)
    diag = store.immutable_artifacts.put_json(
        key=MACRO_STATUS_KEY,
        payload={
            "sources": {
                k: {x: y for x, y in r.items() if x != "events"}
                for k, r in calendar["sources"].items()
            }
        },
        quality=ArtifactQuality(status="warning", warnings=["ons-cancelled"]),
    )
    manifest = store.publish_typed(scope="research", source="synthetic", artifacts=[ref, diag])
    query = events.EventArgs(scope="invest", start="2026-12-03", end="2026-12-03")
    direct = events.event_data(AssistantDepsFactory(store).for_run(), query, upcoming=True)
    (agent,) = direct["data"]["items"]
    with TestClient(app) as client:
        result = client.get(
            f"/v1/snapshots/{manifest.run_id}/events/upcoming",
            params=query.model_dump(exclude_none=True),
        ).json()
        (api,) = result["data"]["items"]
        (health,) = client.get("/health").json()["eventRefreshes"]
    for reading in (agent, api):
        assert (
            reading["date"] == reading["local_date"] == "2026-12" and reading["local_time"] is None
        )
        assert reading["licence_url"].endswith("/open-government-licence/version/3/")
    (failure,) = health["failures"]
    assert failure == {
        "source": "Office for National Statistics (ons-cancelled)",
        "checkedAt": "2026-11-18T11:00:00Z",
    }


def test_cfd_symbol_without_a_venue_stays_in_account_chronology(tmp_path):
    store = ArtifactStore(tmp_path)
    rows = [
        {
            "symbol": "ALFA",
            "record_type": "Order",
            "order_status": "EXECUTED",
            "occurred_at": "2026-11-25T10:00:00Z",
            "units": 2,
        }
    ]
    artifact = store.immutable_artifacts.put_json(key=events.CFD_LEDGER, payload={"events": rows})
    store.publish_typed(scope="research", source="synthetic", artifacts=[artifact])
    deps = AssistantDepsFactory(store).for_run()
    whole = events.event_data(deps, args("cfd"), upcoming=False)
    assert [r["ticker"] for r in whole["data"]["items"]] == ["ALFA"]
    exact = events.event_data(deps, args("cfd", ticker="ALFA"), upcoming=False)
    assert exact["data"]["items"] == [] and "trade_listing_unresolved" in exact["quality"]["issues"]


def test_analyst_lens_retains_eps_with_unpublished_currency(tmp_path, monkeypatch):
    from types import SimpleNamespace

    import yfinance as yf
    from trading_max.research.analyst_evidence import earnings_events
    from trading_max.research.fundamentals import _frame_to_records

    html = """<table>
      <thead><tr><th>Symbol</th><th>Company</th><th>Earnings Date</th>
      <th>EPS Estimate</th><th>Reported EPS</th></tr></thead>
      <tbody><tr><td>ALFA</td><td>Synthetic</td><td>November 25, 2026 at 4 PM EST</td>
      <td>1.2</td><td>1.1</td></tr></tbody></table>"""
    proxy = yf.Ticker("ALFA")
    monkeypatch.setattr(
        type(proxy._data), "cache_get", lambda self, url: SimpleNamespace(text=html)
    )
    observations = earnings_events(
        _frame_to_records(proxy.get_earnings_dates(limit=40)), timezone="America/New_York"
    )
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    store = app.state.store
    analyst = {"earningsEvents": observations, "reportingCurrency": "USD"}
    ref = store.immutable_artifacts.put_json(
        key=events.ANALYST, payload={"rows": [{"ticker": "ALFA", "analyst": analyst}]}
    )
    store.publish_typed(scope="research", source="synthetic", artifacts=[ref])
    with TestClient(app) as client:
        lens = client.get("/v1/research/ALFA/lens/analyst")
        assert lens.status_code == 200, lens.text
        (reported,) = lens.json()["analyst"]["earningsEvents"]
    assert (reported["actualEps"], reported["estimatedEps"], reported["currency"]) == (
        1.1,
        1.2,
        None,
    )
    result = events.event_data(
        AssistantDepsFactory(store).for_run(), args(ticker="ALFA"), upcoming=False
    )
    (reading,) = result["data"]["items"]
    assert reading["status"] == "reported"
    assert reading["actual_eps"] is reading["estimated_eps"] is reading["currency"] is None
    assert "earnings_currency_unavailable" in result["quality"]["issues"]
