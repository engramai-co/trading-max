from __future__ import annotations

import json

import httpx
import pandas as pd
import pytest
from trading_max.analytics.alpaca_prices import (
    AlpacaDataError,
    AlpacaEnhancedPriceLoader,
    AlpacaHistoricalClient,
    us_sessions,
)
from trading_max.analytics.intraday_reconstruction import IntradayPrices, _combined_marks


def ts(value):
    return pd.Timestamp(value, tz="UTC")


def test_paginated_raw_prices_are_completed_and_never_future():
    requests = []

    def reply(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(
                200,
                json={
                    "bars": {"ACME": [{"t": "2026-09-14T06:00:00Z", "c": 100}]},
                    "next_page_token": "next",
                },
            )
        return httpx.Response(
            200,
            json={
                "bars": {
                    "ACME": [
                        {"t": "2026-09-14T06:01:00Z", "c": 101},
                        {"t": "2026-09-14T06:02:00Z", "c": 999},
                    ]
                }
            },
        )

    client = AlpacaHistoricalClient(
        "fixture-key", "fixture-secret", transport=httpx.MockTransport(reply), sleep=lambda _: None
    )
    bars = client.bars("ACME", ts("2026-09-14 06:00"), ts("2026-09-14 06:02"), "boats")
    assert bars.to_dict() == {ts("2026-09-14 06:01"): 100, ts("2026-09-14 06:02"): 101}
    assert requests[1].url.params["page_token"] == "next"
    assert requests[0].url.params["adjustment"] == "raw"
    assert requests[0].url.host == "data.alpaca.markets"


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_provider_errors_do_not_expose_credentials(status):
    calls = []

    def reply(request):
        calls.append(request)
        return httpx.Response(status, json={"message": "fixture-secret"})

    client = AlpacaHistoricalClient(
        "fixture-key", "fixture-secret", transport=httpx.MockTransport(reply), sleep=lambda _: None
    )
    with pytest.raises(AlpacaDataError) as error:
        client.bars("ACME", ts("2026-09-14"), ts("2026-09-15"), "boats")
    assert "fixture-secret" not in str(error.value)
    assert len(calls) == (3 if status >= 429 else 1)


def test_calendar_holidays_dst_and_half_day():
    day, night = us_sessions(ts("2026-03-05"), ts("2026-03-11"))
    assert (ts("2026-03-09 00:00"), ts("2026-03-09 08:00")) in night
    assert (ts("2026-03-06 01:00"), ts("2026-03-06 09:00")) in night
    day, night = us_sessions(ts("2026-11-25"), ts("2026-11-28"))
    assert not any(b == ts("2026-11-26 09:00") for a, b in night)  # Thanksgiving
    assert (ts("2026-11-27 01:00"), ts("2026-11-27 09:00")) in night
    assert (ts("2026-11-27 09:00"), ts("2026-11-27 22:00")) in day


def test_enhancement_overrides_stale_close_but_keeps_gaps_and_yf_fx(tmp_path):
    calls = []

    class Feed:
        def bars(self, symbol, start, end, feed):
            calls.append((symbol, start, end, feed))
            assert end <= ts("2026-09-14 07:44")
            return (
                pd.Series({ts("2026-09-14 07:33"): 90.0})
                if feed == "boats"
                else pd.Series(dtype=float)
            )

    def fallback(symbol, start, end, interval):
        currency = "USD" if symbol != "EXAMPLE.L" else "GBX"
        return IntradayPrices(
            pd.Series({ts("2026-09-12 00:00"): 100.0}), currency, 3600 if interval == "1h" else 300
        )

    loader = AlpacaEnhancedPriceLoader(
        tmp_path, fallback, Feed(), now=lambda: ts("2026-09-14 08:00")
    )
    hourly = loader("ACME", ts("2026-09-10"), ts("2026-09-14 08:00"), "1h")
    fine = loader("ACME", ts("2026-09-11"), ts("2026-09-14 08:00"), "5m")
    timeline = pd.DatetimeIndex(
        [ts("2026-09-14 07:30"), ts("2026-09-14 07:40"), ts("2026-09-14 07:50")]
    )
    values, currency, _ = _combined_marks(hourly, fine, timeline)
    assert currency == "USD"
    assert pd.isna(values.iloc[0]) and values.iloc[1] == 90 and pd.isna(values.iloc[2])
    assert len(calls) == 2  # feeds cached across intervals and accounts
    assert loader("EXAMPLE.L", ts("2026-09-10"), ts("2026-09-14"), "1h").currency == "GBX"
    loader("GBPUSD=X", ts("2026-09-10"), ts("2026-09-14"), "1h")
    assert len(calls) == 2
    assert all(json.loads(p.read_text())["adjustment"] == "raw" for p in tmp_path.glob("*.json"))
    # Process restart reuses the cache without network requests.
    cached = AlpacaEnhancedPriceLoader(
        tmp_path, fallback, Feed(), now=lambda: ts("2026-09-14 08:00")
    )
    cached("ACME", ts("2026-09-10"), ts("2026-09-14 08:00"), "1h")
    assert len(calls) == 2


def test_unavailable_enhancement_retains_yf_without_fake_overnight(tmp_path):
    class Failure:
        def bars(self, *args):
            raise AlpacaDataError("Alpaca boats HTTP 403")

    def fallback(*args):
        return IntradayPrices(
            pd.Series({ts("2026-09-11 20:00"): 100.0, ts("2026-09-14 15:00"): 102.0}), "USD", 300
        )

    loader = AlpacaEnhancedPriceLoader(tmp_path, fallback, Failure(), now=lambda: ts("2026-09-15"))
    prices = loader("ACME", ts("2026-09-10"), ts("2026-09-15"), "5m")
    values, _, _ = _combined_marks(
        prices, prices, pd.DatetimeIndex([ts("2026-09-14 07:40"), ts("2026-09-14 15:00")])
    )
    assert pd.isna(values.iloc[0]) and values.iloc[1] == 102
    assert all(item["status"] == "fallback" for item in loader.diagnostics.values())
