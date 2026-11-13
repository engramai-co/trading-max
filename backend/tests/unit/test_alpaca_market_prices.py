from __future__ import annotations

import multiprocessing
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from trading_max.analytics.sector_board import member_session
from trading_max.infrastructure.alpaca_http import AlpacaDataError, AlpacaHTTP, AlpacaRateBudget
from trading_max.infrastructure.alpaca_market_prices import (
    ALPACA_INTRADAY,
    ALPACA_SIP,
    AlpacaMarketPrices,
    is_alpaca_listing,
)
from trading_max.infrastructure.sector_prices import SparkSeries, parse_compact
from trading_max.infrastructure.shared_market_prices import SharedMarketPrices


def dt(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


def make_prices(tmp_path, reply, now):
    budget = AlpacaRateBudget(tmp_path / "budget.json")
    return AlpacaMarketPrices(
        AlpacaHTTP(
            "fixture-key", "fixture-secret", budget=budget, transport=httpx.MockTransport(reply)
        ),
        now=now,
    )


def test_live_price_uses_iex_snapshot_and_prior_sip_close_and_agrees_with_yahoo(tmp_path):
    opens, closes = dt("2026-11-13T14:30"), dt("2026-11-13T21:00")
    now = [dt("2026-11-13T16:00")]
    sent = []

    def reply(request):
        sent.append(request)
        params = request.url.params
        assert params["symbols"] == "BRK.B"
        if request.url.path.endswith("/snapshots"):
            assert params["feed"] == "iex"
            return httpx.Response(
                200,
                json={
                    "BRK.B": {
                        "latestTrade": {"t": "2026-11-13T15:59:23.123456789Z", "p": 105},
                        "prevDailyBar": {"t": "2026-11-12T05:00:00Z", "c": 98},
                    }
                },
            )
        if params["feed"] == "sip":
            assert datetime.fromisoformat(params["end"]) <= now[0] - timedelta(minutes=15)
            return httpx.Response(
                200,
                json={
                    "bars": {
                        "BRK.B": [
                            {"t": "2026-11-12T05:00:00Z", "c": 100},
                            {"t": "2026-11-13T05:00:00Z", "c": 104},
                        ]
                    }
                },
            )
        assert params["feed"] == "iex"
        return httpx.Response(
            200,
            json={
                "bars": {
                    "BRK.B": [
                        {"t": "2026-11-13T14:30:00Z", "c": 102},
                        {"t": "2026-11-13T15:55:00Z", "c": 103},
                    ]
                }
            },
        )

    alpaca = make_prices(tmp_path, reply, lambda: now[0])
    row = alpaca.intraday(["BRK-B"])["BRK-B"]
    assert row.source == ALPACA_INTRADAY
    assert row.previous_close == 100
    assert row.closes == (102, 103, 105)
    assert row.session_end is None and row.full_day_price is None
    assert len(sent) == 3

    yahoo = parse_compact(
        {
            "BRK-B": {
                "timestamp": list(row.timestamps),
                "close": [102, 103, 105],
                "previousClose": 100,
            }
        }
    )["BRK-B"]
    moves = []
    for item in (row, yahoo):
        observed = member_session(
            item.timestamps,
            item.closes,
            item.previous_close,
            session_open=opens,
            session_close=closes,
        )
        assert observed is not None
        moves.append(observed.change)
    assert moves == pytest.approx([0.05, 0.05])

    now[0] = closes + timedelta(minutes=10)
    waiting = alpaca.intraday(["BRK-B"])["BRK-B"]
    assert waiting.closes[-1] == 105
    assert waiting.session_end is None and waiting.full_day_price is None
    assert alpaca.daily(["BRK-B"])["BRK-B"].closes == (100,)
    now[0] = closes + timedelta(minutes=17)
    settled = alpaca.intraday(["BRK-B"])["BRK-B"]
    assert settled.closes[-1] == settled.full_day_price == 104
    assert settled.session_end == int(closes.timestamp())
    assert alpaca.daily(["BRK-B"])["BRK-B"].closes == (100, 104)


def test_sip_paginates_breadth_and_excludes_partial_daily_bar(tmp_path):
    pages = []

    def reply(request):
        params = request.url.params
        assert params["symbols"] == "BRK.B,QQQ"
        assert params["feed"] == "sip"
        assert params["timeframe"] == "1Day"
        assert params["adjustment"] == "split"
        assert params["limit"] == "10000"
        pages.append(params.get("page_token"))
        if len(pages) == 1:
            return httpx.Response(
                200,
                json={
                    "bars": {
                        "BRK.B": [
                            {"t": "2024-11-18T05:00:00Z", "c": 95},
                        ]
                    },
                    "next_page_token": "p2",
                },
            )
        return httpx.Response(
            200,
            json={
                "bars": {
                    "BRK.B": [{"t": "2026-11-13T05:00:00Z", "c": 88}],
                    "QQQ": [{"t": "2026-11-12T05:00:00Z", "c": 105}],
                }
            },
        )

    alpaca = make_prices(tmp_path, reply, lambda: dt("2026-11-13T17:00"))
    rows = alpaca.breadth_history(["BRK-B", "QQQ"])
    assert pages == [None, "p2"]
    assert rows["BRK-B"].closes == (95,)
    assert rows["QQQ"].source == ALPACA_SIP
    assert rows["QQQ"].closes == (105,)


def test_market_router_only_charges_yahoo_for_fallback_and_toggle_bypasses_cache(tmp_path):
    sent = []
    yahoo = []

    def reply(request):
        sent.append(request.url.params["symbols"])
        return httpx.Response(
            200,
            json={
                "bars": {
                    "QQQ": [{"t": "2026-11-12T05:00:00Z", "c": 105}],
                }
            },
        )

    class Yahoo:
        def daily(self, symbols):
            yahoo.append(symbols)
            return {s: SparkSeries(s, (1,), (90,)) for s in symbols}

    source = make_prices(tmp_path, reply, lambda: dt("2026-11-13T17:00"))
    enabled = [True]
    prices = SharedMarketPrices(Yahoo(), alpaca=lambda: source if enabled[0] else None)
    symbols = ["QQQ", "MISSING", "VWRP.L", "^GSPC", "GBPUSD=X", "ES=F", "BTC-USD"]
    assert [s for s in symbols if is_alpaca_listing(s)] == ["QQQ"]
    symbols[1] = "MISS"
    result = prices.daily(symbols)
    assert sent == ["QQQ,MISS"]
    assert yahoo == [symbols[1:]]
    assert result["QQQ"].closes == (105,)
    assert result["MISS"].closes == (90,)
    assert prices.daily(symbols) == result
    enabled[0] = False
    assert prices.daily(symbols)["QQQ"].closes == (90,)
    assert yahoo[-1] == ["QQQ"]
    assert sent == ["QQQ,MISS"]


def test_market_429_falls_back_and_pauses_worker_for_retry_after(tmp_path):
    clock = [1000.0]
    waited = []
    calls = []

    def pause(seconds):
        waited.append(seconds)
        clock[0] += seconds

    def reply(request):
        calls.append(request.url.path)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "19"})
        return httpx.Response(200, json={"bars": {}})

    first = AlpacaRateBudget(tmp_path / "budget.json", clock=lambda: clock[0])
    worker = AlpacaRateBudget(tmp_path / "budget.json", clock=lambda: clock[0], sleep=pause)
    alpaca = AlpacaMarketPrices(
        AlpacaHTTP(
            "fixture-key", "fixture-secret", budget=first, transport=httpx.MockTransport(reply)
        ),
        now=lambda: dt("2026-11-13T17:00"),
    )

    class Yahoo:
        def daily(self, symbols):
            return {s: SparkSeries(s, (1,), (90,)) for s in symbols}

    prices = SharedMarketPrices(Yahoo(), alpaca=lambda: alpaca)
    assert prices.daily(["SPY"])["SPY"].source == "Yahoo Finance"
    assert prices.daily(["QQQ"])["QQQ"].source == "Yahoo Finance"
    assert len(calls) == 1
    worker.reserve(wait_seconds=90)
    assert waited == [19.0]
    assert clock[0] == 1019


def _reserve_in_process(path, start, done):
    budget = AlpacaRateBudget(path)
    start.wait(10)
    used = 0
    for _ in range(100):
        try:
            budget.reserve(wait_seconds=0)
        except AlpacaDataError:
            continue
        used += 1
    done.put(used)


def test_processes_share_one_rolling_limit(tmp_path):
    context = multiprocessing.get_context("spawn")
    path = tmp_path / "budget.json"
    done = context.Queue()
    start = context.Event()
    # Make the second process enter with quota already used by the first. A
    # real second process must observe the persisted entries, even after exit.
    processes = [
        context.Process(target=_reserve_in_process, args=(path, start, done)) for _ in range(2)
    ]
    try:
        for process in processes:
            process.start()
            start.set()
            process.join(15)
            assert process.exitcode == 0
        assert [done.get(timeout=2), done.get(timeout=2)] == [100, 80]
        with pytest.raises(AlpacaDataError, match="exhausted"):
            AlpacaRateBudget(path).reserve(wait_seconds=0)
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(2)
