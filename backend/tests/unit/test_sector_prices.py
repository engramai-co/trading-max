from __future__ import annotations

from typing import Any

import pytest
from trading_max.infrastructure.sector_prices import (
    BATCH_SIZE,
    SparkRateLimited,
    YahooSparkPrices,
    parse_compact,
    parse_detail,
)
from yfinance.exceptions import YFRateLimitError


class Response:
    def __init__(self, status_code: int, payload: Any = None) -> None:
        self.status_code = status_code
        self.payload = payload

    def json(self) -> Any:
        return self.payload


def compact(symbols: list[str]) -> dict[str, Any]:
    return {
        symbol: {
            "timestamp": [1794182400, 1794182700],
            "close": [10.0, 10.5],
            "previousClose": 10.0,
        }
        for symbol in symbols
    }


def test_parse_compact_reads_points_and_falls_back_to_the_chart_previous_close() -> None:
    series = parse_compact(
        {
            "aaa": {
                "timestamp": [1794182400, 1794182700, None],
                "close": [10.0, None, 11.0],
                "chartPreviousClose": 9.5,
                "end": 1794182700,
                "fulldayPrice": 10.25,
            },
            "BBB": "unexpected",
            "CCC": {"end": True, "fulldayPrice": -1},
            "DDD": {},
        }
    )

    assert list(series) == ["AAA", "CCC", "DDD"]
    assert series["AAA"].timestamps == (1794182400, 1794182700)
    assert series["AAA"].closes == (10.0, None)
    assert series["AAA"].previous_close == 9.5
    assert series["AAA"].session_end == 1794182700
    assert series["AAA"].full_day_price == 10.25
    for symbol in ("CCC", "DDD"):
        assert series[symbol].session_end is None
        assert series[symbol].full_day_price is None


def test_parse_compact_rejects_an_error_envelope() -> None:
    with pytest.raises(ValueError, match="less than or equal to 20"):
        parse_compact(
            {
                "spark": {
                    "result": None,
                    "error": {
                        "description": "Number of symbols needs to be less than or equal to 20"
                    },
                }
            }
        )


def test_parse_detail_reads_names_and_daily_points() -> None:
    series = parse_detail(
        {
            "spark": {
                "result": [
                    {
                        "symbol": "0001.HK",
                        "response": [
                            {
                                "meta": {"longName": "Synthetic Holdings Limited"},
                                "timestamp": [1794013200, 1794099600],
                                "indicators": {"quote": [{"close": [50.0, 51.0]}]},
                            }
                        ],
                    },
                    {"symbol": "MISSING", "response": None},
                ],
                "error": None,
            }
        }
    )

    assert list(series) == ["0001.HK"]
    assert series["0001.HK"].name == "Synthetic Holdings Limited"
    assert series["0001.HK"].closes == (50.0, 51.0)


def test_prices_deal_symbols_round_robin_into_batches_of_twenty() -> None:
    requests: list[list[str]] = []

    def get(url: str, params: dict[str, str], timeout: float) -> Response:
        symbols = params["symbols"].split(",")
        requests.append(symbols)
        assert params["range"] == "1d" and params["interval"] == "5m"
        return Response(200, compact(symbols))

    symbols = [f"S{index:02d}" for index in range(45)] + ["s00"]
    series = YahooSparkPrices(get=get, workers=1).intraday(symbols)

    assert len(series) == 45
    assert [len(batch) for batch in requests] == [15, 15, 15]
    assert all(len(batch) <= BATCH_SIZE for batch in requests)
    # The largest listings come first, so each batch starts with one of them.
    assert [batch[0] for batch in requests] == ["S00", "S01", "S02"]


def test_prices_treat_a_batch_without_data_as_empty_and_keep_the_rest() -> None:
    def get(url: str, params: dict[str, str], timeout: float) -> Response:
        symbols = params["symbols"].split(",")
        if symbols == ["DEAD"]:
            return Response(404, {"spark": {"result": None, "error": {"code": "Not Found"}}})
        if "BROKEN" in symbols:
            return Response(500)
        return Response(200, compact(symbols))

    prices = YahooSparkPrices(get=get, workers=1)
    assert prices.intraday(["DEAD"]) == {}
    assert set(prices.intraday([f"A{index}" for index in range(21)] + ["BROKEN"])) <= {
        f"A{index}" for index in range(21)
    }
    with pytest.raises(RuntimeError, match="HTTP 500"):
        prices.intraday(["BROKEN"])


@pytest.mark.parametrize("throttle", ["status", "exception"])
def test_prices_stop_sending_batches_once_yahoo_rate_limits(throttle: str) -> None:
    sent: list[str] = []

    def get(url: str, params: dict[str, str], timeout: float) -> Response:
        sent.append(params["symbols"])
        if throttle == "exception":
            raise YFRateLimitError()
        return Response(429)

    with pytest.raises(SparkRateLimited):
        YahooSparkPrices(get=get, workers=1).daily([f"S{index}" for index in range(60)])
    assert len(sent) == 1


def test_daily_prices_use_the_detail_endpoint() -> None:
    def get(url: str, params: dict[str, str], timeout: float) -> Response:
        assert url.endswith("/v7/finance/spark")
        assert params["range"] == "1mo" and params["interval"] == "1d"
        return Response(200, {"spark": {"result": [], "error": None}})

    assert YahooSparkPrices(get=get).daily(["AAA"]) == {}
    assert YahooSparkPrices(get=get).daily([]) == {}
