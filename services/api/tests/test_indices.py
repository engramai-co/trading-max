from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from trading_max.infrastructure.sector_prices import SparkRateLimited, SparkSeries

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.indices import IndexService

NOW = datetime(2026, 11, 6, 3, 0, tzinfo=UTC)


def bars(symbol, *rows):
    return SparkSeries(
        symbol,
        tuple(int(datetime.fromisoformat(at).timestamp()) for at, _ in rows),
        tuple(value for _, value in rows),
        previous_close=300,
    )


class FakePrices:
    def __init__(self):
        self.failed = False
        self.intraday_calls = 0
        self.daily_calls = []

    def intraday(self, symbols):
        self.intraday_calls += 1
        if self.failed:
            raise SparkRateLimited("Synthetic cooldown")
        return {
            symbol: bars(
                symbol, ("2026-11-06T02:20:00+00:00", 103), ("2026-11-06T02:30:00+00:00", 101)
            )
            for symbol in symbols
        }

    def daily(self, symbols):
        symbols = list(symbols)
        self.daily_calls.append(symbols)
        if self.failed:
            raise SparkRateLimited("Synthetic cooldown")
        return {
            symbol: bars(
                symbol, ("2026-11-04T00:00:00+00:00", 95), ("2026-11-05T00:00:00+00:00", 100)
            )
            for symbol in symbols
        }

    def history(self, symbol):
        hour = "15" if symbol == "^GSPC" else "00"
        return bars(
            symbol,
            (f"2026-11-02T{hour}:00:00+00:00", 110),
            (f"2026-11-04T{hour}:00:00+00:00", 100),
            (f"2026-11-05T{hour}:00:00+00:00", 105),
            (f"2026-11-06T{hour}:00:00+00:00", 115),
        )


@pytest.fixture
def api(tmp_path):
    clock = [NOW]
    prices = FakePrices()
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    app.state.indices = IndexService(
        tmp_path,
        app.state.sector_monitor.store,
        app.state.sector_monitor.boards,
        prices,
        now=lambda: clock[0],
    )
    with TestClient(app) as client:
        yield client, prices, clock


def test_index_market_uses_dated_close_and_retains_last_read(api):
    client, prices, clock = api
    quotes = client.get("/v1/indices?scope=jp").json()["quotes"]
    msci, nikkei, topix = quotes
    assert nikkei["change"] == pytest.approx(0.01)
    assert nikkei["state"] == "live"  # lunch break does not age the 11:30 print
    assert topix["index"]["kind"] == "etf-price"
    assert topix["index"]["symbol"] == "1306.T"
    assert msci["level"] is None
    assert msci["index"]["rights"] == "licensed-source-required"
    assert client.get("/v1/indices?scope=jp").json()["quotes"] == quotes
    assert prices.intraday_calls == 1

    clock[0] += timedelta(minutes=15)
    prices.failed = True
    response = client.get("/v1/indices?scope=jp").json()
    assert response["refreshFailed"]
    retained = response["quotes"][1]
    assert retained["level"] == nikkei["level"]
    assert retained["asOf"] == nikkei["asOf"]
    assert retained["state"] == "stale"


def test_index_history_risk_uses_completed_daily_bars(api):
    client, _, _ = api
    response = client.get("/v1/indices/nikkei-225/history?range=1M").json()
    assert [point["value"] for point in response["points"]] == [110, 100, 105]
    assert response["maxDrawdown"] == pytest.approx(100 / 110 - 1)
    assert response["volatility"] is not None
    assert response["state"] == "partial"
    assert response["gaps"] == []  # November 3 is a Tokyo holiday.
    missing = client.get("/v1/indices/sp-500/history?range=1M").json()
    assert missing["gaps"] == ["2026-11-03T00:00:00Z"]
    assert missing["volatility"] is None  # only one consecutive daily return
    day = client.get("/v1/indices/nikkei-225/history?range=1D").json()
    assert [point["value"] for point in day["points"]] == [103, 101]
    assert day["maxDrawdown"] is None
    assert client.get("/v1/indices/not-registered/history").status_code == 404
    assert client.get("/v1/indices/nikkei-225/history?range=1Q").status_code == 422


def test_catalog_exposes_worldwide_indices_without_requesting_prices(api):
    client, prices, _ = api
    catalog = client.get("/v1/indices/catalog").json()
    assert "^GSPC" in {index["symbol"] for index in catalog}
    assert {"global", "us", "eu", "uk", "jp", "hk", "kr", "tw", "in", "au", "ch", "ca"} == {
        index["scope"] for index in catalog
    }
    dax = next(index for index in catalog if index["id"] == "dax")
    assert (dax["scope"], dax["basis"]) == ("eu", "total-return")
    assert prices.intraday_calls == 0


def test_composite_observation_does_not_claim_a_local_session(api):
    client, prices, _ = api
    market = client.get("/v1/indices?scope=global").json()
    world = next(quote for quote in market["quotes"] if quote["index"]["id"] == "msci-world")
    assert world["state"] == "observed"
    assert world["level"] == 101
    assert world["change"] == pytest.approx(101 / 300 - 1)
    limited = client.get("/v1/indices/msci-em/history?range=1Y").json()
    assert limited["state"] == "unavailable"
    assert limited["points"] == []
    assert client.get("/v1/indices/msci-em/history?range=1D").json()["points"]
    assert client.get("/v1/indices?scope=cn").status_code == 422
    assert prices.intraday_calls == 1
    assert prices.daily_calls == [["VWRP.L"]]


def test_tracking_exposure_joins_confirmed_benchmarks_by_isin(tmp_path):
    from types import SimpleNamespace

    from trading_max.reference.indices import INDEX_REGISTRY

    from services.api.trading_max_api.sector_monitor import SectorBoardStore

    class Store:
        def latest_manifest(self):
            return SimpleNamespace(run_id="synthetic")

        def read_json(self, run_id, key):
            assert run_id == "synthetic"
            if key == "account/broker_snapshot_metrics.json":

                def position(isin, ticker, value, quantity):
                    return {
                        "isin": isin,
                        "ticker": ticker,
                        "broker_ticker": ticker,
                        "name": "Synthetic holding",
                        "price_currency": "GBP",
                        "quantity": quantity,
                        "current_price": "8",
                        "current_value_gbp": value,
                        "total_cost_gbp": "18",
                        "unrealized_profit_loss_gbp": "0",
                    }

                return {
                    "accounts": {
                        "SYN-A": {
                            "positions": [
                                position("ZZ0000000001", "FIRST", "40", "5"),
                                position("ZZ0000000002", "UNCONFIRMED", "16", "2"),
                            ]
                        },
                        "SYN-B": {"positions": [position("ZZ0000000001", "ALIAS", "8", "1")]},
                    }
                }
            fund = {
                "isin": "ZZ0000000001",
                "tickers": ["FIRST"],
                "indexName": "S&P 500 Index (Net)",
                "holdingsState": "no-holdings",
                "tracking": {"state": "missing"},
                "overlap": {"state": "missing"},
            }
            return {
                "funds": [
                    {
                        **fund,
                        "evidence": {
                            "index_name": {
                                "sourceUrl": "https://example.invalid",
                                "fetchedAt": NOW.isoformat(),
                                "parserVersion": "synthetic",
                                "coverage": "available",
                            }
                        },
                    },
                    {**fund, "isin": "ZZ0000000002", "tickers": ["UNCONFIRMED"]},
                ]
            }

    service = IndexService(
        tmp_path, Store(), SectorBoardStore(tmp_path), FakePrices(), now=lambda: NOW
    )
    result = service.context(INDEX_REGISTRY["sp-500"])
    assert result.exposure_gbp == 48
    assert [(fund.ticker, fund.shares) for fund in result.funds] == [("FIRST", 6)]


def test_shared_quote_cache_reuses_listings_and_honours_rate_limit():
    from trading_max.infrastructure.shared_market_prices import SharedMarketPrices

    class Source:
        def __init__(self):
            self.requests = []

        def intraday(self, symbols):
            self.requests.append(symbols)
            if "THROTTLED" in symbols:
                raise SparkRateLimited("synthetic provider cooldown")
            return {symbol: bars(symbol, ("2026-11-06T02:20:00+00:00", 100)) for symbol in symbols}

        daily = intraday

    source = Source()
    prices = SharedMarketPrices(source)
    assert set(prices.intraday(["SHARED", "ONLY-BOARD"])) == {"SHARED", "ONLY-BOARD"}
    assert set(prices.intraday(["SHARED", "ONLY-INDEX"])) == {"SHARED", "ONLY-INDEX"}
    assert source.requests == [["SHARED", "ONLY-BOARD"], ["ONLY-INDEX"]]
    with pytest.raises(SparkRateLimited):
        prices.intraday(["THROTTLED"])
    assert list(prices.intraday(["SHARED"])) == ["SHARED"]
    with pytest.raises(SparkRateLimited):
        prices.daily(["DAILY"])
    assert source.requests[-1] == ["THROTTLED"]


def test_nasdaq_basket_bounds_off_hours_backfill(api, monkeypatch):
    client, _, clock = api
    requests = []

    def unavailable(market):
        requests.append(market)
        raise OSError("synthetic basket outage")

    monkeypatch.setattr(client.app.state.indices.universes, "get", unavailable)
    for _ in range(6):
        response = client.get("/v1/indices/nasdaq-100/context")
        assert response.status_code == 200
        assert response.json()["basket"] is None
        clock[0] += timedelta(hours=1)
    assert requests == ["ndx"] * 3
