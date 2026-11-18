import pytest
from fastapi.testclient import TestClient
from trading_max.research.held_funds import FUND_PRICES_KEY, FundListingIdentity
from trading_max.research.news import NEWS_KEY

from services.api.tests.assistant_fixture import DATES
from services.api.tests.test_assistant_insights import bound as bound
from services.api.tests.test_assistant_insights import republish
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.events import EventArgs, event_data
from services.api.trading_max_api.models import SecuritySearchResult

FRIDAY = DATES[-3]

MONDAY = DATES[-2]


def publish(app, changes):
    store = app.state.store
    return republish(
        store,
        {
            key: store.immutable_artifacts.put_json(key=key, payload=value)
            for key, value in changes.items()
        },
    )


def put_watch(app, ticker, exchange):
    app.state.watchlist.add(
        SecuritySearchResult(
            ticker=ticker, name="Synthetic", exchange=exchange, bloomberg_ticker="", figi=""
        )
    )


def story(day=FRIDAY, local_instant="T18:00:00Z"):
    return {
        "id": "lead",
        "title": "Synthetic lead",
        "publisher": "Wire",
        "url": "https://example.test/lead",
        "date": day,
        "instant": day + local_instant,
    }


def feed(ticker, **extras):
    return {"securities": {ticker: {"items": [story()], "as_of": FRIDAY, **extras}}}


def block_live(app, monkeypatch):
    def missing(*args, **kwargs):
        raise ValueError("synthetic live history unavailable")

    monkeypatch.setattr(app.state.security_prices, "get", missing)
    monkeypatch.setattr(app.state.security_prices, "alpaca_etf", lambda *args, **kwargs: None)


def base_row(app, manifest, ticker, **extras):
    row = app.state.store.read_json(manifest.run_id, tools.TECHNICAL)["rows"][0]
    return {**row, "ticker": ticker, "exchange": None, **extras}


def moments(app, manifest, ticker, chart=None):
    params = {"ticker": ticker, "scope": "cfd", "start": DATES[0], "end": DATES[-1]}
    if chart and chart.get("publishedSeriesId"):
        params["published_series_id"] = chart["publishedSeriesId"]
    return (
        TestClient(app)
        .get(f"/v1/snapshots/{manifest.run_id}/insights/key-moments", params=params)
        .json()
    )


def entries(app, ticker, *, upcoming):
    return event_data(
        app.state.assistant.deps_for_run(None, None),
        EventArgs(scope="cfd", ticker=ticker, start=DATES[0], end=DATES[-1]),
        upcoming=upcoming,
    )


def all_events(payload):
    return [
        event for item in (payload.get("data") or {}).get("items", []) for event in item["events"]
    ]


@pytest.mark.parametrize(
    ("ticker", "exchange", "at", "expected", "fund"),
    [
        ("SYN", "NYQ", "T20:30:00Z", FRIDAY, False),
        ("SYN.L", "LSE", "T16:34:00Z", FRIDAY, False),
        ("SMH", "NMS", "T20:30:00Z", FRIDAY, True),
        ("VUAG.L", "LSE", "T16:34:00Z", FRIDAY, True),
    ],
)
def test_legacy_us_uk_leads_agree_across_types(bound, ticker, exchange, at, expected, fund):
    app, initial, _ = bound
    row = base_row(app, initial, ticker, exchange=exchange)
    row.pop("asset_type", None)
    if fund:
        row["currency"] = "GBP" if ticker.endswith(".L") else "USD"
    manifest = publish(
        app,
        {
            FUND_PRICES_KEY if fund else tools.TECHNICAL: {"rows": [row]},
            NEWS_KEY: {
                "securities": {ticker: {"items": [story(local_instant=at)], "as_of": FRIDAY}}
            },
        },
    )
    reading = moments(app, manifest, ticker)
    assert [(e["kind"], e["date"]) for e in all_events(reading)] == [("news", expected)], reading[
        "quality"
    ]


def test_chart_and_events_use_the_same_held_alias(bound, monkeypatch):
    app, initial, _ = bound
    listing = FundListingIdentity("SYNTH", "XLON", "SYN", "SYN.L", "LSE")
    monkeypatch.setattr(app.state.research, "_held_funds", lambda m: {listing: {}})
    points = base_row(app, initial, listing.ticker)["price_series"]
    manifest = publish(
        app,
        {
            FUND_PRICES_KEY: {
                "rows": [
                    {
                        "ticker": "SYN.L",
                        "mic": "XLON",
                        "isin": "SYNTH",
                        "exchange": "LSE",
                        "currency": "GBP",
                        "price_series": points,
                    },
                ]
            },
            tools.EARNINGS: {
                "rows": [
                    {"ticker": "SYN", "calendar": {"mic": "XNYS", "Ex-Dividend Date": FRIDAY}},
                    {"ticker": "SYN.L", "calendar": {"mic": "XLON", "Ex-Dividend Date": MONDAY}},
                ]
            },
            NEWS_KEY: {
                "securities": {
                    "SYN": {
                        "mic": "XNYS",
                        "items": [{**story(), "title": "US issue"}],
                        "as_of": FRIDAY,
                    },
                    "SYN.L": {
                        "mic": "XLON",
                        "items": [{**story(), "title": "London issue"}],
                        "as_of": FRIDAY,
                    },
                }
            },
        },
    )
    chart = TestClient(app).get("/v1/research/SYN/prices").json()
    assert chart["ticker"] == "SYN.L"
    looking = entries(app, "SYN", upcoming=False)
    assert not any(
        e.get("ticker") == "SYN" or e.get("title_en") == "US issue"
        for e in looking["data"]["items"]
    ), looking
    assert not any(
        e["date"] == FRIDAY and e["kind"] == "ex_dividend"
        for e in all_events(moments(app, manifest, "SYN", chart))
    )


def test_lens_calendar_respects_pinned_chart_conflict(bound, monkeypatch):
    app, initial, _ = bound
    ticker = "SYN.F"
    block_live(app, monkeypatch)
    publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, mic="XETR", exchange="GER")]},
            tools.FUNDAMENTALS: {
                "rows": [{"ticker": ticker, "metrics": {"fullExchangeName": "Frankfurt"}}]
            },
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": ticker,
                        "calendar": {
                            "mic": "XETR",
                            "Earnings Date": ["2027-07-01"],
                        },
                    }
                ]
            },
        },
    )
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/prices").status_code == 404
    data = client.get(f"/v1/research/{ticker}/lens/technical").json()
    assert not data["context"]["quote"]["schedule"], data["context"]["quote"]["schedule"][
        "calendar"
    ]


def test_key_moment_dividend_respects_parent_earnings_claim(bound, monkeypatch):
    app, initial, _ = bound
    ticker = "SYN.L"
    block_live(app, monkeypatch)
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, mic="XLON", exchange="LSE")]},
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XNYS",
                        "calendar": {
                            "Ex-Dividend Date": FRIDAY,
                        },
                    }
                ]
            },
        },
    )
    looking = entries(app, ticker, upcoming=False)
    assert "listing_calendar_unavailable" in looking["quality"]["issues"]
    reading = moments(app, manifest, ticker)
    assert (
        all_events(reading),
        "listing_calendar_unavailable" in reading["quality"]["issues"],
    ) == ([], True)


def test_same_venue_different_provider_symbol_must_fail(bound, monkeypatch):
    app, initial, _ = bound
    ticker = "SYN.L"
    block_live(app, monkeypatch)
    publish(
        app,
        {
            tools.TECHNICAL: {
                "rows": [
                    base_row(
                        app,
                        initial,
                        ticker,
                        mic="XLON",
                        exchange="LSE",
                        provider_venue={"symbol": "OTHER.L", "exchangeName": "LSE"},
                    )
                ]
            },
        },
    )
    result = TestClient(app).get(f"/v1/research/{ticker}/prices")
    assert result.status_code == 404


def test_intraday_chart_respects_legacy_conflicting_fund_bars(bound, monkeypatch):
    from trading_max.research.venues import VenueClaim

    from services.api.trading_max_api.dashboard_models import ResearchPriceSeries

    app, initial, _ = bound
    ticker = "SMH"
    points = base_row(app, initial, ticker)["price_series"]
    manifest = publish(
        app,
        {
            FUND_PRICES_KEY: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XLON",
                        "exchange": "LSE",
                        "currency": "GBP",
                        "price_series": points,
                    }
                ]
            },
        },
    )
    good_live = ResearchPriceSeries(
        ticker=ticker,
        currency="USD",
        as_of=FRIDAY,
        points=points,
        available_sessions=len(points),
        source="Alpaca (SIP)",
        venue_claims=(VenueClaim("region", "US", ticker),),
    )
    monkeypatch.setattr(app.state.security_prices, "alpaca_etf", lambda *a, **kw: good_live)
    client = TestClient(app)
    assert "listing_calendar_unavailable" in moments(app, manifest, ticker)["quality"]["issues"]
    result = client.get("/v1/research/SMH/prices")
    assert (result.status_code, result.json().get("source")) == (404, None)


def test_published_vienna_segment_identifies_closing_auction(bound):
    from trading_max.research.fundamentals import YFinanceResearchService

    app, initial, _ = bound
    ticker = "AAPL.VI"
    market = {
        "symbol": ticker,
        "exchangeName": "VIE",
        "fullExchangeName": "Vienna",
        "instrumentType": "EQUITY",
    }
    # The actual Yahoo chart and info both omit the segment. Even a future
    # provider info payload supplying it is currently projected out.
    future_info = {
        "symbol": ticker,
        "exchange": "VIE",
        "fullExchangeName": "Vienna",
        "quoteType": "EQUITY",
        "marketSegment": "GMC1",
    }
    fundamentals = YFinanceResearchService(info_loader=lambda ticker: future_info).fundamentals(
        [ticker]
    )
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {
                "rows": [
                    base_row(
                        app,
                        initial,
                        ticker,
                        exchange="VIE",
                        asset_type="EQUITY",
                        provider_venue=market,
                    )
                ]
            },
            tools.FUNDAMENTALS: fundamentals.model_dump(mode="json", by_alias=False),
            NEWS_KEY: {
                "securities": {
                    ticker: {"items": [story(local_instant="T16:32:00Z")], "as_of": FRIDAY}
                }
            },
        },
    )
    reading = moments(app, manifest, ticker)
    assert [(row["kind"], row.get("timing")) for row in all_events(reading)] == [
        ("news", "closing_auction_window"),
    ], reading["quality"]


def test_daily_calendar_uses_raw_provider_claims():
    import pandas as pd
    from trading_max.research.calendar import completed_daily_bars

    frame = pd.DataFrame(
        {"Close": [100.0, 110.0]}, index=pd.DatetimeIndex([MONDAY, DATES[-1]], tz="Europe/London")
    )
    frame.attrs["exchange"] = "LSE"
    frame.attrs["provider_venue"] = {
        "symbol": "SYN.L",
        "exchangeName": "LSE",
        "fullExchangeName": "UNVERIFIED",
    }
    result = completed_daily_bars(frame, now=pd.Timestamp(DATES[-1] + "T17:00:00Z"))
    assert result["Close"].tolist() == [100.0]


def test_provider_fundamentals_publish_every_identity_claim(bound, monkeypatch):
    from trading_max.research.fundamentals import YFinanceResearchService

    app, initial, _ = bound
    ticker = "SYN.L"
    block_live(app, monkeypatch)
    provider = {
        "symbol": ticker,
        "mic": "XLON",
        "exchange": "NYQ",
        "fullExchangeName": "LSE",
        "quoteType": "EQUITY",
    }
    data = YFinanceResearchService(info_loader=lambda symbol: provider).fundamentals([ticker])
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, exchange="LSE", mic="XLON")]},
            tools.FUNDAMENTALS: data.model_dump(mode="json", by_alias=False),
            NEWS_KEY: feed(ticker),
        },
    )
    chart = TestClient(app).get(f"/v1/research/{ticker}/prices")
    reading = moments(app, manifest, ticker)
    assert (chart.status_code, "listing_calendar_unavailable" in reading["quality"]["issues"]) == (
        404,
        True,
    )


def test_provider_qualified_alias_owns_its_evidence(bound, monkeypatch):
    app, initial, _ = bound
    block_live(app, monkeypatch)
    put_watch(app, "SYN", "US")
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {
                "rows": [
                    base_row(
                        app,
                        initial,
                        "SYN",
                        exchange="LSE",
                        provider_venue={"symbol": "SYN.L", "exchangeName": "LSE"},
                    ),
                ]
            },
        },
    )
    chart = TestClient(app).get("/v1/research/SYN/prices")
    reading = moments(app, manifest, "SYN")
    assert (chart.status_code, "listing_calendar_unavailable" in reading["quality"]["issues"]) == (
        404,
        True,
    )


def test_event_parent_claim_blocks_wrong_listing_rating_and_earnings(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, exchange="LSE")]},
            tools.ANALYST: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XNYS",
                        "analyst": {
                            "earningsEvents": [
                                {"id": "wrong-venue", "date": FRIDAY, "status": "reported"}
                            ],
                            "upgradesDowngrades": [
                                {"Firm": "Synthetic", "Action": "up", "GradeDate": FRIDAY}
                            ],
                        },
                    }
                ]
            },
        },
    )
    reading = moments(app, manifest, ticker)
    assert (
        all_events(reading),
        "listing_calendar_unavailable" in reading["quality"]["issues"],
    ) == ([], True)


def test_conflicting_event_parents_are_withheld_in_research_endpoints(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, exchange="LSE")]},
            tools.EARNINGS: {
                "rows": [
                    {"ticker": ticker, "mic": "XNYS", "calendar": {"Earnings Date": ["2027-01-07"]}}
                ]
            },
            tools.FINANCIALS: {
                "rows": [
                    {
                        "ticker": ticker,
                        "mic": "XNYS",
                        "financials": {"evidence": {"news": [story()]}},
                    }
                ]
            },
        },
    )
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/events").json() == []
    lens = client.get(f"/v1/research/{ticker}/lens/technical").json()
    assert lens["nextEarningsDate"] is None
    documents = client.get(f"/v1/research/{ticker}/lens/ledger?detail=documents").json()
    assert not (documents.get("researchEvidence") or {}).get("news")


def test_nested_items_keep_only_the_pinned_listing(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    manifest = publish(
        app,
        {
            tools.TECHNICAL: {"rows": [base_row(app, initial, ticker, exchange="LSE")]},
            tools.ANALYST: {
                "rows": [
                    {
                        "ticker": ticker,
                        "analyst": {
                            "earningsEvents": [
                                {
                                    "mic": "XNYS",
                                    "id": "wrong",
                                    "date": FRIDAY,
                                    "status": "reported",
                                },
                                {
                                    "mic": "XLON",
                                    "id": "right",
                                    "date": MONDAY,
                                    "status": "reported",
                                },
                            ]
                        },
                    }
                ]
            },
            NEWS_KEY: {
                "securities": {
                    ticker: {
                        "as_of": FRIDAY,
                        "items": [
                            {**story(), "mic": "XNYS", "title": "Wrong issue"},
                        ],
                    }
                }
            },
        },
    )
    history = entries(app, ticker, upcoming=False)
    assert not any(
        e["kind"] == "news" or (e["kind"] == "earnings" and e["date"] == FRIDAY)
        for e in history["data"]["items"]
    )
    assert any(e["kind"] == "earnings" and e["date"] == MONDAY for e in history["data"]["items"])
    assert {e["reference"] for e in all_events(moments(app, manifest, ticker))} == {"right"}
