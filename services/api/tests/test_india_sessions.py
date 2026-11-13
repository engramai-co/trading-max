from datetime import UTC, date, datetime

import pytest
from trading_max.reference.indices import INDEX_REGISTRY

from services.api.trading_max_api.global_markets import market_windows
from services.api.trading_max_api.indices import _index_clock
from services.api.trading_max_api.sector_sessions import exchange_sessions


@pytest.mark.parametrize("exchange", ["XNSE", "XBOM"])
def test_verified_india_holidays_and_special_equity_sessions(exchange):
    windows = exchange_sessions(exchange, date(2026, 1, 1), date(2027, 1, 15))
    by_date = {item.date: item for item in windows}
    assert {"2026-01-15", "2026-11-10", "2026-12-25", "2027-01-04"}.isdisjoint(by_date)
    assert by_date["2026-02-01"].open == datetime(2026, 2, 1, 3, 45, tzinfo=UTC)
    assert by_date["2026-02-01"].close == datetime(2026, 2, 1, 10, tzinfo=UTC)
    assert by_date["2026-11-08"].open == datetime(2026, 11, 8, 8, 50, tzinfo=UTC)
    assert by_date["2026-11-08"].close == datetime(2026, 11, 8, 10, tzinfo=UTC)
    assert windows[-1].date == "2026-12-31"


def test_indices_and_world_map_share_the_verified_india_clock():
    during = datetime(2026, 11, 8, 9, tzinfo=UTC)
    start = datetime(2026, 11, 6, 20, tzinfo=UTC)
    world = market_windows("in", start, during)
    assert world
    for key in ("nifty-50", "sensex"):
        _, window, prior = _index_clock(INDEX_REGISTRY[key], during)
        assert window == world[-1]
        assert prior == "2026-11-06"
    unknown = datetime(2026, 12, 31, 19, tzinfo=UTC)  # Already January 1 in Mumbai.
    assert market_windows("in", start, unknown) is None
    assert _index_clock(INDEX_REGISTRY["nifty-50"], unknown)[1:] == (None, None)
