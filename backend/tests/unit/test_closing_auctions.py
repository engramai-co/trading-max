from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from trading_max.research.calendar import market_calendar
from trading_max.research.closing_auctions import headline_session


@pytest.mark.parametrize(
    ("mic", "product", "earliest", "latest"),
    [
        ("XNYS", "EQUITY", "16:00", "16:00"),
        ("XTSE", "EQUITY", "16:00", "16:00"),
        ("XLON", "EQUITY", "16:35", "16:35:30"),
        ("XETR", "EQUITY", "17:35", "17:35:30"),
        ("XFRA", "EQUITY", "22:00", "22:00"),
        ("XHKG", "EQUITY", "16:08", "16:10"),
        ("XWBO", "EQUITY", "17:35", "17:35:30"),
        ("XWBO", "ETF", "17:32", "17:32:30"),
        ("XDUB", "EQUITY", "16:30", "16:30:30"),
        ("XDUB", "ETF", "16:35", "16:35:30"),
        ("XAMS", "EQUITY", "17:35", "17:35:30"),
        ("XBRU", "ETF", "17:35", "17:35:30"),
        ("XPAR", "EQUITY", "17:35", "17:35:30"),
        ("XMIL", "ETF", "17:35", "17:35:30"),
        ("XLIS", "EQUITY", "16:35", "16:35:30"),
        ("XOSL", "EQUITY", "16:25", "16:25:30"),
        ("XCSE", "EQUITY", "16:59:30", "17:00"),
        ("XCSE", "ETF", "16:55", "16:55"),
        ("XSTO", "EQUITY", "17:29:30", "17:30"),
        ("XSTO", "ETF", "17:25", "17:25"),
        ("XHEL", "EQUITY", "18:29:30", "18:30"),
        ("XHEL", "ETF", "18:25", "18:25"),
        ("XMAD", "EQUITY", "17:35", "17:35:30"),
        ("XMAD", "ETF", "17:35", "17:35"),
        ("XSWX", "EQUITY", "17:30", "17:32"),
        ("XSWX", "ETF", "17:35", "17:37"),
        ("XTKS", "EQUITY", "15:30", "15:30"),
        ("XTAI", "EQUITY", "13:30", "13:30"),
        ("XKRX", "EQUITY", "15:30", "15:30:30"),
        ("XASX", "ETF", "16:10", "16:10:30"),
    ],
)
def test_verified_cash_session_cutoffs(mic, product, earliest, latest):
    day = "2026-11-13"
    exchange = market_calendar(mic, 2026, 2026)
    first = datetime.fromisoformat(f"{day}T{earliest}").replace(tzinfo=exchange.tz)
    last = datetime.fromisoformat(f"{day}T{latest}").replace(tzinfo=exchange.tz)
    meta = {"segment": "prime market" if product == "EQUITY" else "ETF2"} if mic == "XWBO" else {}
    assert headline_session(mic, first - timedelta(microseconds=1), product, **meta) == (day, None)
    flag = "closing_auction_window" if first < last else None
    for stamp in (first, first + (last - first) / 2, last):
        assert headline_session(mic, stamp, product, **meta) == (day, flag)
    assert headline_session(mic, last + timedelta(microseconds=1), product, **meta) == (
        "2026-11-16",
        None,
    )


def test_missing_product_or_schedule_only_joins_an_unambiguous_day():
    def local(hour, minute):
        return datetime(2026, 1, 30, hour, minute, tzinfo=ZoneInfo("Europe/Vienna"))

    assert headline_session("XWBO", local(12, 0), None) == ("2026-01-30", None)
    assert headline_session("XWBO", local(17, 33), None) == (None, None)
    assert headline_session("XWBO", local(17, 36), None) == ("2026-02-02", None)
    assert headline_session("UNKNOWN", local(12, 0), "EQUITY") == (None, None)


@pytest.mark.parametrize(
    ("mic", "kind", "day", "next_day", "earliest", "latest"),
    [
        ("XLON", "EQUITY", "2026-12-24", "2026-12-29", "12:35", "12:35:30"),
        ("XNYS", "EQUITY", "2026-11-27", "2026-11-30", "13:00", "13:00"),
        ("XHKG", "ETF", "2026-12-24", "2026-12-28", "12:08", "12:10"),
        ("XWBO", "ETF", "2026-12-30", "2027-01-04", "14:17", "14:17:30"),
        ("XFRA", "EQUITY", "2026-12-30", "2027-01-04", "14:00", "14:00"),
        ("XETR", "ETF", "2026-12-30", "2027-01-04", "14:05", "14:05:30"),
        ("XDUB", "EQUITY", "2026-12-24", "2026-12-29", "12:30", "12:30:30"),
        ("XDUB", "ETF", "2026-12-24", "2026-12-29", "13:00", "13:00:30"),
        ("XPAR", "EQUITY", "2025-12-24", "2025-12-29", "14:00", "14:00:30"),
        ("XLIS", "ETF", "2025-12-24", "2025-12-29", "13:00", "13:00:30"),
        ("XOSL", "EQUITY", "2026-04-01", "2026-04-07", "13:05", "13:05:30"),
        ("XOSL", "ETF", "2026-04-01", "2026-04-07", "13:00", "13:00"),
        ("XMAD", "EQUITY", "2026-12-24", "2026-12-28", "14:00", "14:00:30"),
        ("XMAD", "ETF", "2026-12-24", "2026-12-28", "14:00", "14:00"),
        ("XASX", "EQUITY", "2025-12-24", "2025-12-29", "14:10", "14:10:30"),
    ],
)
def test_shortened_session_uses_its_own_uncross(mic, kind, day, next_day, earliest, latest):
    cal = market_calendar(mic, int(day[:4]), int(day[:4]))
    first = datetime.fromisoformat(f"{day}T{earliest}").replace(tzinfo=cal.tz)
    last = datetime.fromisoformat(f"{day}T{latest}").replace(tzinfo=cal.tz)
    meta = {"segment": "ETF2"} if mic == "XWBO" else {}
    assert headline_session(mic, first - timedelta(seconds=1), kind, **meta) == (day, None)
    assert headline_session(mic, first + (last - first) / 2, kind, **meta) == (
        day,
        "closing_auction_window" if first < last else None,
    )
    assert headline_session(mic, last + timedelta(seconds=1), kind, **meta) == (next_day, None)


def test_vienna_global_market_and_unidentified_segment():
    stamp = datetime(2026, 1, 30, 17, 33, tzinfo=ZoneInfo("Europe/Vienna"))
    assert headline_session("XWBO", stamp, "EQUITY") == (None, None)
    assert headline_session("XWBO", stamp, "EQUITY", segment="global market") == (
        "2026-02-02",
        None,
    )
    assert headline_session("XWBO", stamp, "EQUITY", segment="prime market") == ("2026-01-30", None)


@pytest.mark.parametrize(
    ("product", "segment", "hour", "minute"),
    [
        ("EQUITY", "global market", 17, 32),
        ("EQUITY", "prime market", 17, 35),
        ("ETF", "ETF2", 17, 32),
        ("ETF", "FOAO", 13, 30),
        ("EQUITY", "standard market auction", 13, 30),
    ],
)
def test_vienna_verified_segments_disclose_the_random_uncross(product, segment, hour, minute):
    first = datetime(2026, 1, 30, hour, minute, tzinfo=ZoneInfo("Europe/Vienna"))
    for seconds, expected in (
        (-1, ("2026-01-30", None)),
        (15, ("2026-01-30", "closing_auction_window")),
        (31, ("2026-02-02", None)),
    ):
        assert (
            headline_session("XWBO", first + timedelta(seconds=seconds), product, segment=segment)
            == expected
        )
