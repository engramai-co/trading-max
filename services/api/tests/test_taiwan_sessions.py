from datetime import date

import pytest

from services.api.trading_max_api.sector_sessions import exchange_sessions


@pytest.mark.parametrize("exchange", ["XTAI", "ROCO"])
def test_taiwan_cash_equity_exchanges_do_not_trade_on_settlement_only_days(exchange):
    assert not exchange_sessions(exchange, date(2026, 2, 12), date(2026, 2, 13))
    assert not exchange_sessions(exchange, date(2027, 2, 2), date(2027, 2, 3))
    windows = exchange_sessions(exchange, date(2027, 2, 1), date(2027, 2, 11))
    assert [item.date for item in windows] == ["2027-02-01", "2027-02-11"]
