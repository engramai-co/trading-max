"""Listing identity and quote units across publication formats."""

from fastapi.testclient import TestClient

from services.api.tests.assistant_fixture import DATES
from services.api.tests.test_assistant_insights import bound as bound
from services.api.tests.test_listing_entrypoints import publish, raw_row
from services.api.trading_max_api.agent import tools


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
