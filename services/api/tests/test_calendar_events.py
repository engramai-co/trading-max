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


def publish(store, headline="Synthetic release", *, eps_currency="USD"):
    raw = {
        "title": headline,
        "publisher": "Fixture Press",
        "url": "https://example.org/article",
        "instant": "2026-11-26T00:30:10Z",
    }
    payloads = {
        NEWS_KEY: {
            "securities": {
                "ALFA": {"items": [raw], "as_of": "2026-11-26"},
                "BETA": {"items": [raw], "as_of": "2026-11-26"},
                "WATCH": {"items": [], "as_of": "2026-11-26"},
            }
        },
        events.ANALYST: {
            "rows": [
                {
                    "ticker": "ALFA",
                    "analyst": {
                        "earningsEvents": [
                            {
                                "date": "2026-11-25",
                                "status": "reported",
                                "estimatedEps": 1.2,
                                "actualEps": 1.0,
                                "currency": eps_currency,
                            }
                        ],
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
            "rows": [
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
    assert next(r for r in revised["data"]["items"] if r["kind"] == "earnings")["currency"] is None
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
