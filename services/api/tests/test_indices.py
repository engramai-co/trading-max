import json
import statistics
from dataclasses import replace
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
        self.history_calls = []

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

    def benchmark_intraday(self, symbol):
        return None

    def history(self, symbol):
        hour = "15" if symbol == "^GSPC" else "00"
        return bars(
            symbol,
            (f"2026-11-02T{hour}:00:00+00:00", 110),
            (f"2026-11-04T{hour}:00:00+00:00", 100),
            (f"2026-11-05T{hour}:00:00+00:00", 105),
            (f"2026-11-06T{hour}:00:00+00:00", 115),
        )

    def history_bars(self, symbol, window, now):
        self.history_calls.append((symbol, window, now))
        if window == "MAX":
            return bars(
                symbol,
                ("1999-10-07T04:00:00+00:00", 100),
                ("1999-10-14T04:00:00+00:00", 110),
                ("1999-10-21T04:00:00+00:00", 105),
                ("2026-11-05T05:00:00+00:00", None),
            )
        if window == "1Y":
            return bars(
                symbol,
                ("2026-07-08T21:00:00+00:00", 200),
                ("2026-11-01T22:00:00+00:00", None),
                ("2026-11-02T21:00:00+00:00", 800),
                ("2026-11-02T22:00:00+00:00", 205),
                ("2026-11-02T23:00:00+00:00", 1000),
                ("2026-11-04T22:00:00+00:00", 207),
            )
        if symbol.endswith("=X"):
            return bars(
                symbol,
                ("2026-11-02T13:30:00+00:00", 0.5),
                ("2026-11-02T15:30:00+00:00", 0.75),
            )
        return bars(
            symbol,
            ("2026-10-09T14:00:00+00:00", 95),
            ("2026-11-01T05:00:00+00:00", None),
            ("2026-11-02T14:30:00+00:00", 100),
            ("2026-11-02T15:00:00+00:00", 104),
            ("2026-11-02T15:30:00+00:00", 102),
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

    cached = client.app.state.indices.root / "jp.json"
    legacy = json.loads(cached.read_text())
    for quote in legacy["quotes"]:
        del quote["index"]["ranges"]
    cached.write_text(json.dumps(legacy))

    clock[0] += timedelta(minutes=15)
    prices.failed = True
    response = client.get("/v1/indices?scope=jp").json()
    assert response["refreshFailed"]
    retained = response["quotes"][1]
    assert retained["level"] == nikkei["level"]
    assert retained["asOf"] == nikkei["asOf"]
    assert retained["state"] == "stale"
    assert retained["index"]["ranges"][-1] == "MAX"


def test_index_history_risk_uses_completed_daily_bars(api):
    client, _, _ = api
    response = client.get("/v1/indices/nikkei-225/history?range=3M").json()
    assert [point["value"] for point in response["points"]] == [110, 100, 105]
    assert response["maxDrawdown"] == pytest.approx(100 / 110 - 1)
    assert response["volatility"] is not None
    assert response["state"] == "available"
    assert response["gaps"] == []  # November 3 is a Tokyo holiday.
    missing = client.get("/v1/indices/sp-500/history?range=3M").json()
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
    assert dax["ranges"][-1] == "MAX"
    limited = next(index for index in catalog if index["id"] == "msci-em")
    assert limited["ranges"] == ["1D", "1W", "1M", "3M", "6M", "1Y"]
    assert next(index for index in catalog if index["id"] == "msci-japan")["ranges"] == []
    assert prices.intraday_calls == 0
    assert prices.history_calls == []


def test_composite_observation_does_not_claim_a_local_session(api):
    client, prices, _ = api
    market = client.get("/v1/indices?scope=global").json()
    world = next(quote for quote in market["quotes"] if quote["index"]["id"] == "msci-world")
    assert world["state"] == "observed"
    assert world["level"] == 101
    assert world["change"] == pytest.approx(101 / 300 - 1)
    limited = client.get("/v1/indices/msci-em/history?range=3Y").json()
    assert limited["state"] == "unavailable"
    assert limited["points"] == []
    assert client.get("/v1/indices/msci-em/history?range=1D").json()["points"]
    assert client.get("/v1/indices?scope=cn").status_code == 422
    assert prices.intraday_calls == 1
    assert prices.daily_calls == [["VWRP.L"]]


def test_composite_daily_history_ignores_sunday_but_keeps_weekday_gaps(api, monkeypatch):
    client, prices, _ = api

    def history(symbol):
        return bars(
            symbol,
            ("2026-10-30T04:00:00+00:00", 100),
            ("2026-11-01T04:00:00+00:00", None),
            ("2026-11-02T05:00:00+00:00", 105),
            ("2026-11-03T05:00:00+00:00", None),
            ("2026-11-04T05:00:00+00:00", 110),
        )

    monkeypatch.setattr(prices, "history", history)
    result = client.get("/v1/indices/msci-world/history?range=3M").json()
    assert result["state"] == "partial"
    assert result["gaps"] == ["2026-11-03T00:00:00Z"]
    assert result["volatility"] is None
    assert [point["value"] for point in result["points"]] == [100, 105, 110]


@pytest.mark.parametrize(
    ("period", "values", "gaps"),
    [
        ("1W", [76.5], ["2026-11-02T14:30:00Z", "2026-11-02T15:00:00Z"]),
        ("1M", [50, 76.5], ["2026-10-09T14:00:00Z", "2026-11-02T15:00:00Z"]),
    ],
)
def test_intraday_history_uses_same_window_fx_with_interval_tolerance(api, period, values, gaps):
    client, prices, clock = api
    result = client.get(f"/v1/indices/msci-em/history?range={period}&currency=GBP").json()
    assert [point["value"] for point in result["points"]] == values
    assert result["gaps"] == gaps
    assert result["currency"] == "GBP"
    assert prices.history_calls == [
        ("^891800-USD-STRD", period, clock[0]),
        ("USDGBP=X", period, clock[0]),
    ]


def test_max_uses_completed_weekly_bars_and_weekly_annualisation(api):
    client, _, _ = api
    result = client.get("/v1/indices/sp-500/history?range=MAX").json()
    assert [point["at"] for point in result["points"]] == [
        "1999-10-13T00:00:00Z",
        "1999-10-20T00:00:00Z",
        "1999-10-27T00:00:00Z",
    ]
    assert result["volatility"] == pytest.approx(statistics.stdev([0.1, 105 / 110 - 1]) * 52**0.5)
    assert result["gaps"] == []


def test_limited_msci_uses_hourly_close_in_the_new_york_zone(api):
    client, prices, clock = api
    result = client.get("/v1/indices/msci-em/history?range=1Y").json()
    assert result["hourlyClose"]
    assert [point["value"] for point in result["points"]] == [200, 205, 207]
    assert result["gaps"] == []
    assert prices.history_calls == [("^891800-USD-STRD", "1Y", clock[0])]


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
    assert set(prices.intraday([" shared ", "ONLY-INDEX"])) == {"SHARED", "ONLY-INDEX"}
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


def test_chart_windows_cache_separately_and_share_the_rate_limit(monkeypatch):
    from types import SimpleNamespace

    from trading_max.infrastructure import shared_market_prices

    requests = []

    def get(url, params, timeout):
        requests.append(params)
        if url.endswith("THROTTLED"):
            return SimpleNamespace(status_code=429)
        granularity = "1h" if params["interval"] == "60m" else params["interval"]
        return SimpleNamespace(
            status_code=200,
            json=lambda: {
                "chart": {
                    "result": [
                        {
                            "meta": {"dataGranularity": granularity},
                            "timestamp": [1],
                            "indicators": {"quote": [{"close": [100]}]},
                        }
                    ]
                }
            },
        )

    monkeypatch.setattr(shared_market_prices, "_yahoo_get", get)
    prices = shared_market_prices.SharedMarketPrices()
    now = datetime(2026, 3, 31, 13, tzinfo=UTC)
    assert prices.history_bars("SYN", "1W", now)
    assert prices.history_bars("SYN", "1W", now + timedelta(minutes=1))
    assert prices.history_bars("SYN", "1M", now)
    assert prices.history_bars("SYN", "MAX", now)
    assert requests == [
        {
            "period1": str(int((now - timedelta(days=7)).timestamp())),
            "period2": str(int(now.timestamp())),
            "interval": "30m",
        },
        {
            "period1": str(int(now.replace(month=2, day=28).timestamp())),
            "period2": str(int(now.timestamp())),
            "interval": "60m",
        },
        {"period1": "0", "period2": str(int(now.timestamp())), "interval": "1wk"},
    ]
    with pytest.raises(SparkRateLimited):
        prices.history_bars("THROTTLED", "MAX", now)
    assert prices.history_bars("SYN", "MAX", now)
    with pytest.raises(SparkRateLimited, match="paused"):
        prices.history("ANOTHER")
    assert len(requests) == 4


def test_global_endpoint_caches_the_session_aligned_response(api, monkeypatch):
    from services.api.trading_max_api.global_markets import read_global_contribution

    client, _, clock = api
    service = client.app.state.indices
    calls = []

    def compute(prices, weights, stale, now, clock):
        calls.append(now)
        return read_global_contribution(prices, weights, stale, now, clock)

    monkeypatch.setattr("services.api.trading_max_api.indices.read_global_contribution", compute)
    monkeypatch.setattr(service.acwi_weights, "get", lambda _: (None, False))
    response = client.get("/v1/indices/global-contribution")
    assert response.status_code == 200
    result = response.json()
    assert result["phase"] is None
    assert result["state"] == "unavailable"
    assert result["residual"] is None
    assert len(result["markets"]) == 11
    assert result["rows"] == []
    assert client.get("/v1/indices/global-contribution").json() == result
    assert calls == [NOW]

    clock[0] += timedelta(minutes=5)
    assert client.get("/v1/indices/global-contribution").status_code == 200
    assert calls == [NOW, clock[0]]


def test_global_sectors_endpoint_uses_shared_clock_and_caches_public_board(api, monkeypatch):
    from services.api.trading_max_api.global_sectors import read_global_sectors

    client, _, clock = api
    service = client.app.state.indices
    calls = []

    def compute(prices, weights, stale, now, reference):
        calls.append((now, reference))
        return read_global_sectors(prices, weights, stale, now, reference)

    monkeypatch.setattr("services.api.trading_max_api.indices.read_global_sectors", compute)
    monkeypatch.setattr(service.world_sector_weights, "get", lambda _: (None, False))
    monkeypatch.setattr(service.acwi_weights, "get", lambda _: (None, False))

    response = client.get("/v1/indices/global-sectors")
    assert response.status_code == 200
    result = response.json()
    assert len(result["sectors"]) == 11
    assert result["weightsAsOf"] is None
    assert result["sectors"][-1]["indexCode"] == 132085
    assert result["sectors"][-1]["move"] is None
    assert client.get("/v1/indices/global-sectors").json() == result
    contribution = client.get("/v1/indices/global-contribution").json()
    assert all(result[key] == contribution[key] for key in ("phase", "referenceDate", "asOf"))
    assert calls == [(NOW, service._global_reference()[1])]

    clock[0] += timedelta(minutes=5)
    assert client.get("/v1/indices/global-sectors").status_code == 200
    assert len(calls) == 2


def test_market_request_budget_reserves_opening_and_closing_capacity(monkeypatch):
    from trading_max.infrastructure import shared_market_prices as shared

    clock = [100.0]
    monkeypatch.setattr(shared.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(shared, "REQUEST_BUDGET", ((60, 1, 2), (86400, 2, 3)))

    class Source:
        def intraday(self, symbols):
            return {symbol: bars(symbol, ("2026-11-06T02:20:00+00:00", 100)) for symbol in symbols}

        daily = intraday

    prices = shared.SharedMarketPrices(Source())
    assert prices.intraday(["ONE"])
    with pytest.raises(shared.MarketPriceBudgetExhausted):
        prices.daily(["ONE"])
    assert prices.intraday(["ONE"])  # cache hits do not spend the budget
    with shared.market_price_priority(True):
        assert prices.daily(["ONE"])
        with pytest.raises(shared.MarketPriceBudgetExhausted):
            prices.intraday(["TWO"])
        clock[0] += 60
        assert prices.intraday(["TWO"])
        with pytest.raises(shared.MarketPriceBudgetExhausted):
            prices.intraday(["THREE"])
    assert not prices.rate_limited  # a budget deferral is not a provider 429


@pytest.mark.parametrize("current", [True, False])
def test_taiwan_quote_uses_matching_provider_close_when_daily_bar_is_null(api, current):
    client, prices, clock = api
    clock[0] = datetime(2026, 11, 6, 21, tzinfo=UTC)
    day = "2026-11-06" if current else "2026-11-05"
    end = f"{day}T05:30:00+00:00"
    prices.intraday = lambda symbols: {
        symbol: replace(
            bars(symbol, (end, 98)),
            session_end=int(datetime.fromisoformat(end).timestamp()),
            full_day_price=99,
        )
        for symbol in symbols
    }
    prices.daily = lambda symbols: {
        symbol: bars(
            symbol, ("2026-11-05T01:00:00+00:00", 100), ("2026-11-06T01:00:00+00:00", None)
        )
        for symbol in symbols
    }
    response = client.get("/v1/indices?scope=tw").json()
    quote = next(row for row in response["quotes"] if row["index"]["id"] == "taiex")
    if current:
        assert quote["state"] == "closed"
        assert quote["level"] == 99
        assert quote["change"] == pytest.approx(-0.01)
        assert quote["sessionDate"] == "2026-11-06"
    else:
        assert quote["state"] == "unavailable"
        assert quote["level"] is None
        assert response["refreshFailed"]
