"""Listing identity and quote units across publication formats."""

import pytest
from fastapi.testclient import TestClient
from trading_max.research.news import NEWS_KEY

from services.api.tests.assistant_fixture import DATES
from services.api.tests.test_assistant_insights import bound as bound
from services.api.tests.test_listing_entrypoints import publish, raw_row, watch
from services.api.trading_max_api.agent import insights, tools
from services.api.trading_max_api.agent.events import EventArgs, event_data


def technical(app, manifest, ticker, exchange=None, unit="GBP", price=30):
    row = raw_row(
        app, manifest, ticker, yf_ticker=ticker, currency=unit, price=price, as_of=DATES[-1]
    )
    if exchange:
        row["exchange"] = exchange
    row["price_series"][-1]["close"] = price
    return row


def test_legacy_bar_without_a_compact_quote_does_not_relabel_pounds_as_pence(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    price_row = technical(app, initial, ticker, "LSE", unit="", price=31)
    price_row["price_series"][-1]["dividend"] = 1.2
    markers = {
        "calculation_version": "trade-markers-v4",
        "rows": [
            {
                "ticker": ticker,
                "date": DATES[-1],
                "kind": "B",
                "accounts": ["isa"],
                "buy_orders": 1,
                "buy_quantity": 2,
                "sell_orders": 0,
                "sell_quantity": 0,
                "fills": [
                    {
                        "at": DATES[-1] + "T14:00:00Z",
                        "side": "buy",
                        "account": "isa",
                        "quantity": 2,
                        "amount": 62,
                        "currency": "GBP",
                        "price": 31,
                        "price_currency": "GBP",
                        "broker_ticker": "SYNl_EQ",
                    }
                ],
            }
        ],
    }
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [price_row]},
            "account/trade_markers.json": markers,
            tools.FUNDAMENTALS: {
                "rows": [
                    {
                        "ticker": ticker,
                        "currency": "GBp",
                        "metrics": {"exchange": "LSE", "symbol": ticker, "quoteType": "EQUITY"},
                    }
                ]
            },
        },
    )
    response = TestClient(app).get(f"/v1/research/{ticker}/prices")
    assert response.status_code == 200
    body = response.json()
    dividend = body["events"][-1]
    marker = body["tradeMarkers"][0]
    observed = (
        body["currency"],
        body["points"][-1]["close"],
        dividend["currency"],
        dividend["value"],
        marker["buyAveragePrice"],
        marker["accounts"],
    )
    assert observed == ("GBP", 31, "GBP", 1.2, 31, ["isa"])
    assert marker["fills"][0]["amount"] == 62


@pytest.mark.parametrize("symbol", ["BP", "SHEL"])
def test_exact_provider_symbol_survives_a_separate_london_publication(bound, symbol):
    app, manifest, _ = bound
    london = symbol + ".L"
    watch(app, london, "LSE")
    exact = technical(app, manifest, symbol, unit="USD", price=31)
    exact["provider_venue"] = {"symbol": symbol}
    publish(
        app,
        **{tools.TECHNICAL: {"rows": [exact, technical(app, manifest, london, "LSE", price=71)]}},
    )
    client = TestClient(app)
    for request, unit, close in [(symbol, "USD", 31), (london, "GBP", 71)]:
        response = client.get(f"/v1/research/{request}/prices")
        assert response.status_code == 200
        series = response.json()
        assert (series["ticker"], series["currency"], series["points"][-1]["close"]) == (
            request,
            unit,
            close,
        )


def test_historical_verified_london_alias_survives_a_bar_key_change(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    watch(app, ticker, "LSE")
    prior = publish(
        app, **{tools.TECHNICAL: {"rows": [technical(app, initial, ticker, "LSE", price=28)]}}
    )
    current = publish(
        app, **{tools.TECHNICAL: {"rows": [technical(app, initial, "SYN", "LSE", price=30)]}}
    )
    client = TestClient(app)
    assert client.get(f"/v1/research/{ticker}/prices").json()["exchangeCalendar"] == "XLON"
    timeline = client.get(f"/v1/research/{ticker}/timeline").json()
    assert {row["runId"] for row in timeline if row.get("technical")} == {
        prior.run_id,
        current.run_id,
    }


def test_legacy_verified_london_feed_remains_available_to_qualified_chart(bound):
    app, initial, _ = bound
    ticker = "SYN.L"
    watch(app, ticker, "LSE")
    day = DATES[-3]
    publish(
        app,
        **{
            tools.TECHNICAL: {"rows": [technical(app, initial, "SYN", "LSE")]},
            tools.MARKET: {
                "technical": {
                    "rows": [
                        {
                            "ticker": "SYN",
                            "exchange": "LSE",
                            "price": 30,
                            "currency": "GBP",
                            "as_of": day,
                        }
                    ]
                }
            },
            tools.FUNDAMENTALS: {
                "rows": [
                    {
                        "ticker": "SYN",
                        "currency": "GBP",
                        "metrics": {"exchange": "LSE", "symbol": "SYN", "quoteType": "EQUITY"},
                    }
                ]
            },
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": "SYN",
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
                    "SYN": {
                        "as_of": day,
                        "items": [
                            {
                                "id": "wire",
                                "title": "Synthetic London listing",
                                "publisher": "Wire",
                                "url": "https://example.test/wire",
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
    result = event_data(
        app.state.assistant.deps_for_run(None, None),
        EventArgs(ticker=ticker, scope="cfd", start=DATES[0], end=DATES[-1]),
        upcoming=False,
    )
    assert (
        lens["context"]["quote"]["price"],
        bool(lens["technical"]),
        lens["nextEarningsDate"],
        len(legacy),
        sorted(e["kind"] for e in result["data"]["items"]),
    ) == (
        30,
        True,
        "2027-08-14",
        1,
        ["ex_dividend", "news"],
    )

    deps = app.state.assistant.deps_for_run(None, None)
    args = insights.MomentsArgs(ticker=ticker, scope="cfd", start=DATES[0], end=DATES[-1])
    series = deps.price_series(ticker, deps.manifest)
    entries, _, _ = insights.dated_events(
        tools._Read(deps, "price_key_moments", args, "cfd"), args, set(), series
    )
    assert {entry["kind"] for entry in entries} == {"ex_dividend", "news"}
