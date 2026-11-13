from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event

from services.api.trading_max_api.dashboard_models import ResearchPriceSeries
from services.api.trading_max_api.research_prices import SecurityPriceHistory


def test_preview_window_retains_genuine_ohlc_and_full_history_indicators():
    from services.api.trading_max_api.research_prices import price_window

    original = series("TEST")
    point = original.points[0]
    original.points = [
        point.model_copy(update={"date": "2025-01-02", "sma200": 1.1}),
        point.model_copy(update={"date": "2025-12-01", "sma200": 1.7}),
        point.model_copy(update={"date": "2026-01-02", "sma200": 1.9}),
    ]
    projected = price_window(original, "3M")
    assert projected.points == original.points[-2:]
    assert projected.points[0].sma200 == 1.7
    assert len(original.points) == 3


def series(ticker):
    return ResearchPriceSeries(
        ticker=ticker,
        as_of="2026-01-02",
        currency="USD",
        available_sessions=1,
        requested_interval="15m",
        actual_interval="15m",
        fetched_at=datetime.now(UTC).isoformat(),
        points=[
            {
                "date": "2026-01-02T14:30:00Z",
                "open": 1,
                "high": 2,
                "low": 1,
                "close": 2,
                "volume": 100,
                "sma20": None,
                "sma50": None,
                "sma200": None,
            }
        ],
    )


def test_route_mutation_cannot_trim_shared_price_history(tmp_path, monkeypatch):
    prices = SecurityPriceHistory(tmp_path)
    calls = []
    monkeypatch.setattr(
        prices, "_fetch", lambda ticker, interval, path: calls.append(ticker) or series(ticker)
    )
    first = prices.get("TEST", "15m")
    first.points.clear()
    assert len(prices.get("test", "15m").points) == 1
    assert calls == ["TEST"]


def test_cold_price_does_not_block_cached_other_ticker(tmp_path, monkeypatch):
    prices = SecurityPriceHistory(tmp_path)
    started, release = Event(), Event()

    def fetch(ticker, interval, path):
        if ticker == "COLD":
            started.set()
            if not release.wait(5):
                raise TimeoutError("test did not release provider")
        return series(ticker)

    monkeypatch.setattr(prices, "_fetch", fetch)
    prices.get("HOT", "15m")
    with ThreadPoolExecutor(2) as pool:
        cold = pool.submit(prices.get, "COLD", "15m")
        assert started.wait(2)
        try:
            assert pool.submit(prices.get, "HOT", "15m").result(timeout=1).ticker == "HOT"
        finally:
            release.set()
        assert cold.result().ticker == "COLD"


def test_expired_memory_entry_is_refetched(tmp_path, monkeypatch):
    prices = SecurityPriceHistory(tmp_path)
    old = series("TEST").model_copy(
        update={"fetched_at": (datetime.now(UTC) - timedelta(minutes=6)).isoformat()}
    )
    responses = iter([old, series("TEST")])
    monkeypatch.setattr(prices, "_fetch", lambda *args: next(responses))
    prices.get("TEST", "15m")
    assert prices.get("TEST", "15m").fetched_at != old.fetched_at


def test_short_preview_cannot_poison_full_history_or_indicator_values(tmp_path, monkeypatch):
    import pandas as pd

    from services.api.trading_max_api import research_prices

    frame = pd.DataFrame(
        {
            key: [100 + i / 10 for i in range(300)]
            for key in ("Open", "High", "Low", "Close", "Volume")
        },
        index=pd.date_range("2024-01-01", periods=300, freq="B", tz="UTC"),
    )
    periods = []

    class Provider:
        def history(self, **kwargs):
            periods.append(kwargs["period"])
            return frame.tail(126).copy() if kwargs["period"] == "6mo" else frame.copy()

        def get_history_metadata(self):
            return {
                "currency": "USD",
                "exchangeTimezoneName": "America/New_York",
                "exchangeName": "NYQ",
            }

    monkeypatch.setattr(research_prices.yf, "Ticker", lambda ticker: Provider())
    cache = SecurityPriceHistory(tmp_path)
    preview = cache.get("TEST", "1d", preview=True)
    full = cache.get("TEST", "1d")
    assert len(preview.points) == 126 and len(full.points) == 300
    assert preview.points[-1].close == full.points[-1].close
    assert preview.points[-1].sma200 is None
    assert full.points[-1].sma200 is not None
    assert cache.get("TEST", "1d").points == full.points
    assert periods == ["6mo", "10y"]


def test_etf_price_chart_uses_sip_and_switch_off_invalidates_its_cache(tmp_path):
    import httpx
    from trading_max.infrastructure.alpaca_http import AlpacaHTTP, AlpacaRateBudget
    from trading_max.infrastructure.alpaca_market_prices import ALPACA_SIP, AlpacaMarketPrices

    requests = []

    def reply(request):
        params = request.url.params
        requests.append(params)
        assert params["symbols"] == "SPY"
        assert params["feed"] == "sip"
        assert params["adjustment"] == "split,dividend"
        return httpx.Response(
            200,
            json={
                "bars": {
                    "SPY": [
                        {
                            "t": "2026-11-12T05:00:00Z",
                            "o": 100,
                            "h": 102,
                            "l": 99,
                            "c": 101,
                            "v": 3100,
                        },
                        {
                            "t": "2026-11-13T05:00:00Z",
                            "o": 101,
                            "h": 112,
                            "l": 100,
                            "c": 109,
                            "v": 3900,
                        },
                    ]
                }
            },
        )

    source = AlpacaMarketPrices(
        AlpacaHTTP(
            "fixture-key",
            "fixture-secret",
            budget=AlpacaRateBudget(tmp_path / "budget.json"),
            transport=httpx.MockTransport(reply),
        ),
        now=lambda: datetime(2026, 11, 13, 20, tzinfo=UTC),
    )
    enabled = [source]
    history = SecurityPriceHistory(tmp_path, alpaca=lambda: enabled[0])
    result = history.alpaca_etf("SPY", "1d")
    assert result and result.source == ALPACA_SIP
    assert result.as_of == "2026-11-12"
    assert len(result.points) == 1 and result.points[0].close == 101
    assert result.points[0].volume == 3100
    assert history.alpaca_etf("SPY", "1d") == result
    enabled[0] = None
    assert history.alpaca_etf("SPY", "1d") is None
    assert len(requests) == 1
