"""Listing identity across published, live and historical research."""

from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_max.analytics.decision_prices import CachedDailyHistory, resolve_decision_prices
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.held_funds import (
    FUND_PRICE_DIRECTORY_KEY,
    FUND_PRICES_KEY,
    FundListingIdentity,
)
from trading_max.research.news import NEWS_KEY
from trading_max.research.venues import VenueConflict

from backend.tests.unit.test_decision_review import _fill, _trade_columns
from services.api.tests.assistant_fixture import DATES
from services.api.tests.test_assistant_insights import bound as bound
from services.api.tests.test_assistant_insights import republish
from services.api.tests.test_assistant_tools import _call
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.events import EventArgs, event_data
from services.api.trading_max_api.dashboard_models import ResearchPriceSeries
from services.api.trading_max_api.models import SecuritySearchResult


def publish(app, **artifacts):
    store = app.state.store
    return republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=value)
            for key, value in artifacts.items()
        },
    )


def raw_row(app, manifest, ticker, **fields):
    return {
        **app.state.store.read_json(manifest.run_id, tools.TECHNICAL)["rows"][0],
        "ticker": ticker,
        "currency": "GBP" if ticker.endswith(".L") else "USD",
        **fields,
    }


def watch(app, ticker, exchange):
    result = SecuritySearchResult(
        ticker=ticker, name="Synthetic", exchange=exchange, bloomberg_ticker="", figi=""
    )
    app.state.watchlist.add(result)
    return result


@pytest.mark.parametrize("legacy", [False, True])
def test_public_preview_uses_the_same_live_conflict_as_the_chart(bound, monkeypatch, legacy):
    app, initial, _ = bound
    ticker = "SYN.L"
    search = watch(app, ticker, "LSE")
    row = raw_row(app, initial, ticker, exchange="LSE")
    publish(app, **{tools.TECHNICAL: {"rows": [row]}})
    monkeypatch.setattr(app.state.security_search, "exact", lambda *_: search)

    def live(*args, **kwargs):
        if not legacy:
            raise VenueConflict("provider history claimed XNYS")
        return ResearchPriceSeries(
            ticker=ticker,
            as_of=DATES[-1],
            currency="GBP",
            points=row["price_series"],
            available_sessions=len(row["price_series"]),
            published_bar_ticker=ticker,
            published_bar_exchange="NYQ",
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/prices?interval=15m").status_code == 404
    result = client.get(f"/v1/research/{ticker}/lens/technical?preview=true").json()
    assert (
        result["context"]["quote"]["schedule"],
        result["context"]["quote"]["price"],
        result["technical"],
    ) == (None, None, None)


def test_new_york_price_history_cannot_join_historical_london_timeline(bound, monkeypatch):
    app, initial, _ = bound
    row_us = raw_row(app, initial, "SYN", exchange="NYQ")
    row_uk = raw_row(app, initial, "SYN.L", exchange="LSE")
    previous = publish(app, **{tools.TECHNICAL: {"rows": [row_us]}})
    listing = FundListingIdentity("SYNTH", "XLON", "SYN", "SYN.L", "LSE")
    bars = {**row_uk, "mic": listing.mic, "isin": listing.isin}
    directory = {k: v for k, v in bars.items() if k != "price_series"}
    current = publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [row_uk]},
            FUND_PRICES_KEY: {"rows": [bars]},
            FUND_PRICE_DIRECTORY_KEY: {"rows": [directory]},
        },
    )
    monkeypatch.setattr(
        app.state.research,
        "_held_funds",
        lambda manifest: {listing: {}} if manifest.run_id == current.run_id else {},
    )
    client = TestClient(app)
    chart = client.get("/v1/research/SYN/prices")
    assert (chart.status_code, chart.json()["ticker"], chart.json()["exchangeCalendar"]) == (
        200,
        "SYN.L",
        "XLON",
    )
    timeline = client.get("/v1/research/SYN/timeline").json()
    observed = {(p["runId"], p["technical"]["ticker"]) for p in timeline if p.get("technical")}
    assert (current.run_id, "SYN.L") in observed
    assert (previous.run_id, "SYN") not in observed


def test_london_watchlist_cannot_displace_an_exact_new_york_price_row(bound):
    app, initial, _ = bound
    watch(app, "SYN.L", "LSE")
    publish(
        app,
        **{
            tools.TECHNICAL: {
                "rows": [
                    raw_row(app, initial, "SYN", exchange="NYQ"),
                    raw_row(app, initial, "SYN.L", exchange="LSE"),
                ]
            }
        },
    )
    result = TestClient(app).get("/v1/research/SYN/prices")
    assert (result.status_code, result.json()["ticker"], result.json()["exchangeCalendar"]) == (
        200,
        "SYN",
        "XNYS",
    )


def test_verified_legacy_london_price_alias_keeps_qualified_london_events(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    watch(app, ticker, "LSE")
    exhibit = raw_row(app, initial, "SYN", exchange="LSE", currency="GBP")
    day = DATES[-3]
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [exhibit]},
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XLON",
                        "calendar": {
                            "Ex-Dividend Date": day,
                            "Earnings Date": ["2027-08-14"],
                        },
                    }
                ]
            },
            NEWS_KEY: {
                "securities": {
                    ticker: {
                        "as_of": day,
                        "items": [
                            {
                                "id": "lead",
                                "title": "Synthetic qualified London news",
                                "publisher": "Wire",
                                "url": "https://example.test/london",
                                "date": day,
                            }
                        ],
                    }
                }
            },
        },
    )
    client = TestClient(app)
    chart = client.get(f"/v1/research/{ticker}/prices")
    assert (chart.status_code, chart.json()["exchangeCalendar"]) == (200, "XLON")
    lens = client.get(f"/v1/research/{ticker}/lens/technical").json()
    legacy = client.get(f"/v1/research/{ticker}/events").json()
    events = event_data(
        app.state.assistant.deps_for_run(None, None),
        EventArgs(ticker=ticker, scope="cfd", start=DATES[0], end=DATES[-1]),
        upcoming=False,
    )
    assert (
        lens["nextEarningsDate"],
        len(legacy),
        sorted(e["kind"] for e in events["data"]["items"] if e.get("ticker") == ticker),
    ) == ("2027-08-14", 1, ["ex_dividend", "news"])


def test_assistant_stored_lens_cannot_bypass_conflict_when_watchlist_is_unreadable(
    bound, monkeypatch
):
    app, initial, _ = bound
    ticker = "SYN.F"
    publish(
        app,
        **{
            tools.TECHNICAL: {
                "rows": [
                    raw_row(app, initial, ticker, exchange="GER", mic="XETR"),
                ]
            }
        },
    )
    args = tools.ResearchArgs(ticker=ticker, lens="technical")
    deps = app.state.assistant.deps_for_run(None, None)
    assert _call(deps, tools.read_research_lens, args)["status"] == "unavailable"

    def missing():
        raise OSError("synthetic watchlist temporarily unavailable")

    monkeypatch.setattr(app.state.watchlist, "listing_exchanges", missing)
    deps = app.state.assistant.deps_for_run(None, None)
    result = _call(deps, tools.read_research_lens, args)
    assert (result["status"], bool(result.get("data"))) == ("unavailable", False)


def test_wrong_same_venue_symbol_cannot_be_cached_as_decision_history(tmp_path):
    def wrong_history(symbol, start, end):
        return pd.DataFrame(
            {"Close": [200.0, 205.0, 210.0]},
            index=pd.DatetimeIndex(["2026-01-28", "2026-01-29", "2026-01-30"], tz="Europe/London"),
        )

    def with_identity(symbol, start, end):
        frame = wrong_history(symbol, start, end)
        frame.attrs.update(
            exchange="LSE", provider_venue={"symbol": "OTHER.L", "exchangeName": "LSE"}
        )
        return frame

    clock = pd.Timestamp("2026-01-30T17:00:00Z").to_pydatetime()
    cache = CachedDailyHistory(tmp_path, fetch=with_identity, now=lambda: clock)
    for completed in (
        cache("SYN.L", date(2026, 1, 28), date(2026, 1, 30)),
        cache.read_cached("SYN.L", date(2026, 1, 28), date(2026, 1, 30)),
    ):
        assert completed.empty, completed["Close"].tolist()


def test_selected_original_quote_unit_for_bar_dividends(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    row = raw_row(app, initial, ticker, exchange="LSE", currency="GBP")
    row["price_series"][-1]["dividend"] = 1.2
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [row]},
            tools.MARKET: {
                "technical": {
                    "rows": [
                        {
                            "ticker": ticker,
                            "currency": "USD",
                            "price": 25,
                            "exchange": "LSE",
                        }
                    ]
                }
            },
        },
    )
    response = TestClient(app).get(f"/v1/research/{ticker}/prices")
    if response.status_code == 200:
        assert (response.json()["currency"], response.json()["events"][-1]["currency"]) == (
            "GBP",
            "GBP",
        )
    else:
        assert response.status_code == 404


def test_valuations_tool_does_not_return_conflicting_stored_listing_quote(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [raw_row(app, initial, ticker, exchange="LSE")]},
            tools.MARKET: {
                "generated_at": DATES[-1],
                "technical": {
                    "rows": [
                        {
                            "ticker": ticker,
                            "currency": "GBP",
                            "price": 25,
                            "as_of": DATES[-1],
                            "exchange": "NYQ",
                        }
                    ]
                },
            },
            tools.FUNDAMENTALS: {
                "generated_at": DATES[-1],
                "rows": [
                    {
                        "ticker": ticker,
                        "currency": "GBP",
                        "metrics": {"symbol": ticker, "exchange": "LSE", "quoteType": "EQUITY"},
                    }
                ],
            },
        },
    )
    client = TestClient(app)
    chart = client.get(f"/v1/research/{ticker}/prices")
    result = _call(
        app.state.assistant.deps_for_run(None, None),
        tools.read_valuation_evidence,
        tools.ValuationArgs(ticker=ticker, listing="LSE:SYN", group="basis"),
    )
    spot = [
        (item["value"], item["currency"])
        for item in (result.get("data") or {}).get("items", [])
        if item["metric"] == "spot" and item["state"] == "available"
    ]
    assert (chart.status_code, spot) == (404, [])


def test_account_decision_picks_only_the_symbol_the_provider_owns():
    clock = pd.Timestamp("2026-01-30T17:00:00Z")
    trades = _trade_columns(
        pd.DataFrame([_fill("2026-01-28T12:00:00Z", "Market buy", 5, 1000, "SYN")])
    )

    def history(symbol, start, end):
        if symbol == "GBPUSD=X":
            return pd.DataFrame({"Close": 1.25}, index=pd.bdate_range(start, end))
        if symbol != "SYN.L":
            raise ValueError("no synthetic bars for this candidate")
        frame = pd.DataFrame({"Close": 200.0}, index=pd.bdate_range(start, end))
        frame.attrs.update(
            exchange="LSE", provider_venue={"symbol": "OTHER.L", "exchangeName": "LSE"}
        )
        return frame

    prices, unpriced = resolve_decision_prices(
        trades, end_day=pd.Timestamp("2026-01-30"), history_loader=history, now=clock
    )
    assert (list(prices), unpriced) == ([], ["SYN"])


def test_frankfurt_conflict_withholds_all_published_chart_dependents_and_london_stays_available(
    bound, monkeypatch
):
    app, initial, _ = bound
    frankfurt, london = "SYN.F", "GOOD.L"
    for symbol, exchange in ((frankfurt, "Frankfurt"), (london, "LSE")):
        watch(app, symbol, exchange)
    day = DATES[-3]

    def news(symbol):
        return {
            "as_of": day,
            "items": [
                {
                    "id": symbol,
                    "title": "Synthetic news",
                    "publisher": "Wire",
                    "url": "https://example.test/" + symbol,
                    "date": day,
                }
            ],
        }

    manifest = publish(
        app,
        **{
            tools.TECHNICAL: {
                "rows": [
                    raw_row(app, initial, frankfurt, exchange="GER", mic="XETR"),
                    raw_row(app, initial, london, exchange="LSE", mic="XLON"),
                ]
            },
            tools.FUNDAMENTALS: {
                "rows": [
                    {
                        "ticker": frankfurt,
                        "metrics": {"symbol": frankfurt, "fullExchangeName": "Frankfurt"},
                    },
                    {"ticker": london, "metrics": {"symbol": london, "fullExchangeName": "LSE"}},
                ]
            },
            tools.MARKET: {
                "technical": {
                    "rows": [
                        {"ticker": frankfurt, "price": 70, "currency": "EUR", "as_of": DATES[-1]},
                        {"ticker": london, "price": 95, "currency": "GBP", "as_of": DATES[-1]},
                    ]
                }
            },
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": frankfurt,
                        "calendar": {"Earnings Date": ["2027-08-14"], "Ex-Dividend Date": day},
                    },
                    {
                        "ticker": london,
                        "calendar": {"Earnings Date": ["2027-08-14"], "Ex-Dividend Date": day},
                    },
                ]
            },
            NEWS_KEY: {"securities": {symbol: news(symbol) for symbol in (frankfurt, london)}},
        },
    )
    client = TestClient(app)
    deps = app.state.assistant.deps_for_run(None, None)
    for symbol, present in ((frankfurt, False), (london, True)):
        chart = client.get(f"/v1/research/{symbol}/prices")
        assert chart.status_code == (200 if present else 404)
        if present:
            assert chart.json()["exchangeCalendar"] == "XLON"
        for view in ("overview", "technical"):
            lens = client.get(f"/v1/research/{symbol}/lens/{view}").json()
            assert bool(lens["context"]["quote"]["price"]) is present
            assert bool(lens["context"]["quote"]["schedule"]) is present
            assert bool(lens["technical"]) is present
            assert bool(lens["nextEarningsDate"]) is present
        legacy = client.get(f"/v1/research/{symbol}/events").json()
        assert bool(legacy) is present
        events = event_data(
            deps,
            EventArgs(ticker=symbol, scope="cfd", start=DATES[0], end=DATES[-1]),
            upcoming=False,
        )
        assert bool([e for e in events["data"]["items"] if e.get("ticker") == symbol]) is present
        moments = client.get(
            f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
            params={"ticker": symbol, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
        ).json()
        assert bool((moments.get("data") or {}).get("items")) is present


def test_held_fund_keeps_conflicting_exact_bar_claims_even_when_isin_mic_filter_rejects_row(
    bound, monkeypatch
):
    app, initial, _ = bound
    ticker = "SYN.L"
    row = raw_row(app, initial, ticker, exchange="NYQ", mic="XNYS", isin="SYNTH")
    listing = FundListingIdentity("SYNTH", "XLON", "SYN", ticker, "LSE")
    monkeypatch.setattr(app.state.research, "_held_funds", lambda _: {listing: {}})
    publish(app, **{FUND_PRICES_KEY: {"rows": [row]}})

    def live(*args, **kwargs):
        return ResearchPriceSeries(
            ticker=ticker,
            as_of=DATES[-1],
            currency="GBP",
            points=row["price_series"],
            available_sessions=len(row["price_series"]),
            published_bar_ticker=ticker,
            published_bar_exchange="LSE",
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    response = TestClient(app).get(f"/v1/research/{ticker}/prices?interval=15m")
    assert response.status_code == 404


def test_public_preview_cannot_reopen_a_conflicting_published_listing(bound, monkeypatch):
    app, initial, _ = bound
    ticker = "SYN.F"
    search = watch(app, ticker, "Frankfurt")
    row = raw_row(app, initial, ticker, exchange="GER", mic="XETR")
    publish(app, **{tools.TECHNICAL: {"rows": [row]}})
    monkeypatch.setattr(app.state.security_search, "exact", lambda *_: search)

    def live(*args, **kwargs):
        from trading_max.research.venues import row_claims

        return ResearchPriceSeries(
            ticker=ticker,
            as_of=DATES[-1],
            currency="EUR",
            points=row["price_series"],
            available_sessions=len(row["price_series"]),
            published_bar_ticker=ticker,
            published_bar_exchange="FRA",
            venue_claims=row_claims(ticker, {"exchange": "FRA"}),
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/prices").status_code == 404
    result = client.get(f"/v1/research/{ticker}/lens/technical?preview=true").json()
    assert (
        [result["context"]["quote"].get(k) for k in ("price", "schedule", "listing")],
        result["technical"],
    ) == ([None, None, None], None)


def test_options_lens_keeps_contracts_on_exact_listing(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [raw_row(app, initial, ticker, exchange="LSE")]},
            tools.OPTIONS: {
                "rows": [
                    {
                        "ticker": "SYN",
                        "yf_ticker": "SYN",
                        "currency": "USD",
                        "spot": 100,
                        "expiry_count": 1,
                        "captured_at": DATES[-1] + "T16:00:00Z",
                    }
                ]
            },
        },
    )
    client = TestClient(app)
    chart = client.get(f"/v1/research/{ticker}/prices")
    assert (chart.status_code, chart.json()["exchangeCalendar"]) == (200, "XLON")
    data = client.get(f"/v1/research/{ticker}/lens/options").json()
    assert data["options"] is None


def test_live_alerts_cannot_treat_pence_as_pounds(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    watch(app, ticker, "LSE")
    broker = app.state.store.read_json(initial.run_id, tools.BROKER)
    broker["accounts"]["A"]["positions"][0].update(
        ticker=ticker, broker_ticker="SYNl_EQ", current_price=90, price_currency="GBP"
    )
    row = raw_row(app, initial, ticker, exchange="LSE")
    row.update(price=90, structure={"support20": 100})
    manifest = publish(
        app,
        **{
            tools.BROKER: broker,
            tools.TECHNICAL: {"rows": [row]},
        },
    )
    client = TestClient(app)
    alerts_path = f"/v1/research/{ticker}/alerts"
    assert any(a["alertId"].endswith(":support-breach") for a in client.get(alerts_path).json())
    app.state.alert_monitor.live_store.save(
        {
            "snapshotRunId": manifest.run_id,
            "quotes": {
                ticker: {"price": 9000, "asOf": DATES[-1] + "T16:00:00Z", "currency": "GBp"}
            },
        }
    )
    assert any(a["alertId"].endswith(":support-breach") for a in client.get(alerts_path).json())


def test_published_benchmark_uses_completed_bars_on_both_legs(monkeypatch):
    from trading_max.research import market, technical

    from backend.tests.unit.test_market_research import _history

    now = pd.Timestamp("2026-11-27T17:59:00Z")  # NYSE closes early at 18:00 UTC.

    class Clock(pd.Timestamp):
        @classmethod
        def now(cls, *, tz):
            return now

    class SyntheticPandas:
        Timestamp = Clock

        def __getattr__(self, name):
            return getattr(pd, name)

    monkeypatch.setattr(market, "pd", SyntheticPandas())
    monkeypatch.setattr(technical, "pd", SyntheticPandas())

    def history(symbol, period):
        frame = _history(symbol, period)
        tail = frame.iloc[[-1]].copy()
        tail.index = pd.DatetimeIndex(["2026-11-27T00:00:00Z"])
        tail["Close"] = 200
        frame = pd.concat([frame, tail])
        exchange = None if symbol == "GBPUSD=X" else "PCX"
        frame.attrs.update(
            ticker=symbol,
            exchange=exchange,
            provider_venue={
                "symbol": symbol,
                "exchangeName": exchange,
            },
        )
        return frame

    service = market.MarketResearchService(history_loader=history, adr_loader=lambda *args: None)
    result, _ = service.run(["VOO"], include_options=False)
    assert result.rows[0].as_of < "2026-11-27"
    assert result.benchmark_series["VOO"][-1]["date"] < "2026-11-27"


def test_live_london_request_uses_qualified_provider_symbol_with_bare_legacy_bars(
    bound, monkeypatch
):
    app, initial, _ = bound
    ticker = "SYN.L"
    watch(app, ticker, "LSE")
    row = raw_row(app, initial, "SYN", exchange="LSE", currency="GBP")
    publish(app, **{tools.TECHNICAL: {"rows": [row]}})
    asked = []

    def live(symbol, interval, **kwargs):
        asked.append(symbol)
        correct = symbol == ticker
        return ResearchPriceSeries(
            ticker=symbol,
            as_of=DATES[-1],
            currency="GBP" if correct else "USD",
            points=row["price_series"],
            available_sessions=len(row["price_series"]),
            actual_interval=interval,
            published_bar_ticker=symbol,
            published_bar_exchange="LSE" if correct else "NYQ",
        )

    monkeypatch.setattr(app.state.security_prices, "get", live)
    client = TestClient(app)
    daily = client.get(f"/v1/research/{ticker}/prices")
    assert (daily.status_code, daily.json()["exchangeCalendar"]) == (200, "XLON")
    intraday = client.get(f"/v1/research/{ticker}/prices?interval=15m")
    assert (intraday.status_code, asked, intraday.json().get("actualInterval")) == (
        200,
        [ticker],
        "15m",
    )


def test_conflicting_fundamentals_identity_survives_without_any_fundamental_metric(
    bound, monkeypatch
):
    app, initial, _ = bound
    ticker = "SYN.L"
    provider = {"symbol": "OTHER.L", "exchange": "LSE", "mic": "XLON"}
    facts = YFinanceResearchService(info_loader=lambda _: provider).fundamentals([ticker])
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [raw_row(app, initial, ticker, exchange="LSE")]},
            tools.FUNDAMENTALS: facts.model_dump(mode="json", by_alias=False),
        },
    )
    assert TestClient(app).get(f"/v1/research/{ticker}/prices").status_code == 404


def test_unverified_event_alias_does_not_poison_ordinary_london_headline(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    day = DATES[-3]
    manifest = publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [raw_row(app, initial, ticker, exchange="LSE")]},
            tools.ANALYST: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XNYS",
                        "analyst": {
                            "earningsEvents": [
                                {"date": day, "status": "reported", "id": "wrong-venue"}
                            ]
                        },
                    }
                ]
            },
            NEWS_KEY: {
                "securities": {
                    ticker: {
                        "as_of": day,
                        "mic": "XLON",
                        "items": [
                            {
                                "id": "compatible-news",
                                "date": day,
                                "instant": day + "T15:00:00Z",
                                "title": "Synthetic same-listing news",
                                "publisher": "Wire",
                                "url": "https://example.test/london",
                            }
                        ],
                    }
                }
            },
        },
    )
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/prices").status_code == 200
    result = client.get(
        f"/v1/snapshots/{manifest.run_id}/insights/key-moments",
        params={"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": DATES[-1]},
    ).json()
    assert {event["reference"] for item in result["data"]["items"] for event in item["events"]} == {
        "compatible-news"
    }
    history = event_data(
        app.state.assistant.deps_for_run(None, None),
        EventArgs(ticker=ticker, scope="cfd", start=DATES[0], end=DATES[-1]),
        upcoming=False,
    )
    assert {
        event["reference"] for event in history["data"]["items"] if event.get("ticker") == ticker
    } == {"compatible-news"}
