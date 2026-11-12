from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from trading_max.infrastructure.sector_prices import SparkRateLimited, SparkSeries
from trading_max.infrastructure.sector_universe import SectorConstituent, SectorUniverse
from trading_max.reference import CatalogSecurityMaster
from trading_max.reference.security_master import (
    GicsClassification,
    SecurityEntityRecord,
    SecurityMasterCatalog,
)

from services.api.trading_max_api import sector_monitor
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import (
    WatchlistCategory,
    WatchlistItem,
    WatchlistState,
)
from services.api.trading_max_api.sector_context import (
    PortfolioExposure,
    market_key,
    member_key,
    shared_exposure,
    theme_grouping,
)
from services.api.trading_max_api.sector_models import (
    SectorBoard,
    SectorMarketStatus,
    SectorSessionWindow,
    SectorSource,
)
from services.api.trading_max_api.sector_monitor import (
    SectorMonitor,
    SectorRefreshCancelled,
    SectorRefreshError,
    default_market,
)
from services.api.trading_max_api.sector_sessions import (
    BACKFILL_ATTEMPTS,
    COMPLETE_AFTER,
    GIVE_UP_AFTER,
    board_complete,
    in_break,
    is_due,
    latest_session,
    next_session,
    prior_session_dates,
    sessions_between,
)
from services.api.trading_max_api.watchlist import WatchlistStore

US_OPEN = datetime(2026, 11, 6, 14, 30, tzinfo=UTC)
US_CLOSE = datetime(2026, 11, 6, 21, 0, tzinfo=UTC)
SESSION = "2026-11-06"
PRIOR = ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]


def constituent(
    symbol: str, weight: float, sector: str = "45", isin: str = "", name: str = ""
) -> SectorConstituent:
    sector_name = {"45": "Information Technology", "40": "Financials"}[sector]
    return SectorConstituent(
        symbol=symbol,
        ticker=symbol.split(".")[0],
        name=name or f"SYNTHETIC {symbol}",
        isin=isin,
        sector_code=sector,
        sector_name=sector_name,
        weight=weight,
    )


def universe(market: str, *members: SectorConstituent) -> SectorUniverse:
    return SectorUniverse(
        market=market,
        universe=f"Synthetic {market.upper()} index",
        fund="Synthetic UCITS ETF",
        fund_ticker="SYN",
        source_url="https://example.invalid/synthetic",
        as_of="2026-11-05",
        fetched_at="2026-11-06T06:00:00+00:00",
        constituents=list(members),
    )


class FakeUniverses:
    def __init__(self, **markets: SectorUniverse) -> None:
        self.markets = markets
        self.on_get: Callable[[str], None] | None = None

    def get(self, market: str) -> SectorUniverse:
        if self.on_get is not None:
            self.on_get(market)
        # Markets a test does not price get a symbol no fake quotes.
        return self.markets.get(market) or universe(market, constituent(f"IDLE.{market}", 1.0))


def series(
    symbol: str,
    previous: float,
    points: list[tuple[float, float]],
    *,
    opened: datetime = US_OPEN,
) -> SparkSeries:
    return SparkSeries(
        symbol=symbol,
        timestamps=tuple(int((opened + timedelta(minutes=m)).timestamp()) for m, _ in points),
        closes=tuple(price for _, price in points),
        previous_close=previous,
    )


def daily_series(symbol: str, closes: dict[str, float], name: str = "") -> SparkSeries:
    return SparkSeries(
        symbol=symbol,
        timestamps=tuple(
            int(datetime.fromisoformat(f"{day}T14:30:00+00:00").timestamp()) for day in closes
        ),
        closes=tuple(closes.values()),
        name=name,
    )


def history(symbol: str, values: list[float], name: str = "", **today: float) -> SparkSeries:
    closes = dict(zip(PRIOR, values, strict=True))
    if "close" in today:
        closes[SESSION] = today["close"]
    return daily_series(symbol, closes, name)


class FakePrices:
    def __init__(
        self,
        intraday: dict[str, SparkSeries] | None = None,
        daily: dict[str, SparkSeries] | None = None,
    ) -> None:
        self.quotes = intraday or {}
        self.history = daily or {}
        self.intraday_requests: list[list[str]] = []
        self.daily_requests: list[list[str]] = []
        self.raise_intraday: Exception | None = None
        self.on_intraday: Callable[[], None] | None = None

    def intraday(self, symbols):
        requested = list(symbols)
        self.intraday_requests.append(requested)
        if self.on_intraday is not None:
            self.on_intraday()
        if self.raise_intraday is not None:
            raise self.raise_intraday
        return {symbol: self.quotes[symbol] for symbol in requested if symbol in self.quotes}

    def daily(self, symbols):
        requested = list(symbols)
        self.daily_requests.append(requested)
        return {symbol: self.history[symbol] for symbol in requested if symbol in self.history}


def monitor(
    root: Path,
    universes: FakeUniverses,
    prices: FakePrices,
    clock: dict[str, datetime],
    *,
    enabled: bool = True,
) -> SectorMonitor:
    return SectorMonitor(
        root,
        ArtifactStore(root),
        WatchlistStore(root),
        available=True,
        enabled=enabled,
        universes=universes,
        prices=prices,
        now=lambda: clock["now"],
    )


def window(day: str, opened: str, closed: str, **breaks: str) -> SectorSessionWindow:
    return SectorSessionWindow(
        date=day,
        open=datetime.fromisoformat(f"{day}T{opened}:00+00:00"),
        close=datetime.fromisoformat(f"{day}T{closed}:00+00:00"),
        **{key: datetime.fromisoformat(f"{day}T{value}:00+00:00") for key, value in breaks.items()},
    )


# Listings and exposure -----------------------------------------------------


@pytest.mark.parametrize(
    ("ticker", "exchange", "bloomberg", "key"),
    [
        ("BE", "NYSE", "", ("us", "BE")),
        ("BE", "US", "", ("us", "BE")),
        ("NVDA", "", "NVDA US Equity", ("us", "NVDA")),
        ("BRK.B", "NYSE", "", ("us", "BRK-B")),
        ("BRK-B", "NMS", "", ("us", "BRK-B")),
        ("RR.L", "LSE", "", ("uk", "RR")),
        ("BT.A.L", "LSE", "", ("uk", "BT-A")),
        ("HSBA", "LSE", "", ("uk", "HSBA")),
        ("HSBA", "", "HSBA LN Equity", ("uk", "HSBA")),
        ("700.HK", "HKG", "", ("hk", "0700")),
        ("0700.HK", "", "", ("hk", "0700")),
        ("005930.KS", "KSC", "", ("kr", "005930")),
        ("196170.KQ", "", "", ("kr", "196170")),
        # A generic US venue never outranks an explicit listing suffix.
        ("HSBA.L", "US", "HSBA.L US Equity", ("uk", "HSBA")),
        # Without a US venue an unsuffixed ticker is not a US listing.
        ("ASML", "", "", None),
        ("ASML", "AMS", "", None),
        ("SAP", "GER", "SAP US Equity", None),
        ("SAP", "", "SAP GY Equity", None),
        ("XYZ.L", "AMS", "", None),
        ("0700.HK", "LSE", "", None),
        ("SEMI.AS", "US", "", None),
        ("7203.T", "", "", None),
        ("", "", "", None),
        # A named exchange decides alone; only an unnamed one lets the Bloomberg
        # code (often a generic "<ticker> US Equity") stand in.
        ("SYN", "Toronto Stock Exchange", "SYN US Equity", None),
        ("SYN", "NYSE", "SYN CN Equity", ("us", "SYN")),
        ("SYN", "Unknown", "SYN US Equity", ("us", "SYN")),
        ("SYN", "N/A", "SYN CN Equity", None),
        # An exchange name these lists do not know never blocks a listing suffix.
        ("700.HK", "Hong Kong Exchanges And Clearing Ltd", "", ("hk", "0700")),
    ],
)
def test_listings_need_venue_evidence(
    ticker: str, exchange: str, bloomberg: str, key: tuple[str, str] | None
) -> None:
    assert market_key(ticker, exchange, bloomberg) == key


def test_board_symbols_use_the_same_keys() -> None:
    assert member_key("us", "BRK-B") == ("us", "BRK-B")
    assert member_key("uk", "BT-A.L") == ("uk", "BT-A")
    assert member_key("hk", "0700.HK") == ("hk", "0700")
    assert member_key("kr", "196170.KQ") == ("kr", "196170")


def test_each_look_through_value_is_assigned_once() -> None:
    portfolio = PortfolioExposure(
        by_entity={"issuer": 60.0, "pair": 90.0},
        by_isin={"XS0000000001": 40.0, "XS0000000009": 40.0},
    )
    exposure = shared_exposure(
        [
            # A resolved row and an unresolved row with its ISIN both belong here.
            ("A", "issuer", "XS0000000001", 0.5),
            # Two listings of one unresolved ISIN share it by weight.
            ("B1", None, "xs0000000009", 0.3),
            ("B2", None, "XS0000000009", 0.1),
            # Share classes of one issuer share it equally when unweighted.
            ("C1", "pair", "", 0.0),
            ("C2", "pair", "", 0.0),
            ("D", "other", "", 0.2),
        ],
        portfolio,
    )
    assert exposure == pytest.approx(
        {"A": 100.0, "B1": 30.0, "B2": 10.0, "C1": 45.0, "C2": 45.0, "D": 0.0}
    )
    assert sum(exposure.values()) == pytest.approx(230.0)


# Sessions -----------------------------------------------------------------


def test_exchange_sessions_follow_each_calendar() -> None:
    hong_kong = sessions_between("hk", date(2026, 11, 6), date(2026, 11, 9))
    assert [session.date for session in hong_kong] == [SESSION, "2026-11-09"]
    assert hong_kong[0].break_start == datetime(2026, 11, 6, 4, tzinfo=UTC)
    assert hong_kong[0].break_end == datetime(2026, 11, 6, 5, tzinfo=UTC)

    weekend = datetime(2026, 11, 7, 12, tzinfo=UTC)
    current = latest_session("us", weekend)
    assert current is not None and current.date == SESSION
    assert (current.open, current.close) == (US_OPEN, US_CLOSE)
    upcoming = next_session("kr", weekend)
    assert upcoming is not None and upcoming.open == datetime(2026, 11, 9, tzinfo=UTC)
    assert prior_session_dates("us", SESSION, 5) == PRIOR
    assert prior_session_dates("us", SESSION, 0) == []


def test_refresh_timing_rules() -> None:
    session = window(SESSION, "01:30", "08:00", break_start="04:00", break_end="05:00")
    morning = datetime(2026, 11, 6, 3, tzinfo=UTC)
    lunch = datetime(2026, 11, 6, 4, 10, tzinfo=UTC)

    assert is_due(session, None, False, morning)
    assert is_due(session, SESSION, False, morning)
    assert not is_due(session, SESSION, True, morning)
    # The slot at the break captures the morning close; the rest of the break waits.
    assert is_due(session, SESSION, False, datetime(2026, 11, 6, 4, tzinfo=UTC))
    assert in_break(session, lunch)
    assert not is_due(session, SESSION, False, lunch)
    assert not is_due(session, None, False, lunch)
    assert is_due(session, SESSION, False, datetime(2026, 11, 6, 5, tzinfo=UTC))
    # Boards are refreshed until a few hours after the close.
    assert is_due(session, "2026-11-05", True, datetime(2026, 11, 6, 11, 30, tzinfo=UTC))
    assert is_due(session, SESSION, False, datetime(2026, 11, 6, 10, tzinfo=UTC))
    assert not is_due(session, "2026-11-07", False, morning)
    # Later, a session still without its closing board is filled a few times, whatever was
    # stored: no board, an older session's, or this session's unsettled one (a restart).
    late = datetime(2026, 11, 7, 12, tzinfo=UTC)
    for stored, complete in ((None, False), ("2026-11-05", True), (SESSION, False)):
        assert is_due(session, stored, complete, late)
        assert is_due(session, stored, complete, late, backfill_attempts=BACKFILL_ATTEMPTS - 1)
        assert not is_due(session, stored, complete, late, backfill_attempts=BACKFILL_ATTEMPTS)
    assert not is_due(session, SESSION, True, late)
    just_after = datetime(2026, 11, 6, 11, 31, tzinfo=UTC)
    assert not is_due(session, "2026-11-05", True, just_after, backfill_attempts=BACKFILL_ATTEMPTS)
    assert not board_complete(session, datetime(2026, 11, 6, 8, 29, tzinfo=UTC))
    assert board_complete(session, datetime(2026, 11, 6, 8, 30, tzinfo=UTC))


def test_default_market_prefers_the_trading_market_with_most_exposure() -> None:
    def status(market: str, exposure: float, *sessions: SectorSessionWindow) -> SectorMarketStatus:
        return SectorMarketStatus(
            market=market,
            calendar="SYN",
            timezone="UTC",
            sessions=list(sessions),
            exposure_gbp=exposure,
        )

    statuses = [
        status("us", 900.0, window(SESSION, "14:30", "21:00")),
        status("uk", 100.0, window(SESSION, "08:00", "16:30")),
        status("hk", 0.0, window(SESSION, "01:30", "08:00")),
        status("kr", 50.0, window(SESSION, "00:00", "06:30")),
    ]
    assert default_market(statuses, datetime(2026, 11, 6, 15, tzinfo=UTC)) == "us"
    assert default_market(statuses, datetime(2026, 11, 6, 9, tzinfo=UTC)) == "uk"
    assert default_market(statuses, datetime(2026, 11, 6, 5, tzinfo=UTC)) == "kr"
    assert default_market(statuses, datetime(2026, 11, 6, 22, tzinfo=UTC)) == "us"
    assert default_market(statuses, datetime(2026, 11, 6, 7, tzinfo=UTC)) == "hk"
    assert default_market([], datetime(2026, 11, 6, 7, tzinfo=UTC)) == "us"


# Refresh ------------------------------------------------------------------


def us_board_inputs(*, official: bool = False) -> tuple[FakeUniverses, FakePrices]:
    universes = FakeUniverses(
        us=universe(
            "us",
            constituent("AAA", 0.5),
            constituent("BE", 0.3),
            constituent("CCC", 0.2, sector="40"),
        )
    )
    today = {"AAA": 105.0, "BE": 49.0, "CCC": 20.4} if official else {}
    prices = FakePrices(
        intraday={
            "AAA": series("AAA", 100.0, [(0, 101.0), (5, 102.0), (85, 104.0)]),
            "BE": series("BE", 50.0, [(0, 49.0), (85, 49.5)]),
            "CCC": series("CCC", 20.0, [(5, 20.0), (85, 20.2)]),
        },
        daily={
            "AAA": history(
                "AAA",
                [90.0, 91.0, 92.0, 93.0, 100.0],
                "Alpha Synthetic Inc.",
                **_close(today, "AAA"),
            ),
            "BE": history("BE", [50.0, 50.0, 49.0, 52.0, 50.0], **_close(today, "BE")),
            "CCC": history("CCC", [20.0, 21.0, 20.0, 20.0, 20.0], **_close(today, "CCC")),
        },
    )
    return universes, prices


def _close(today: dict[str, float], symbol: str) -> dict[str, float]:
    return {"close": today[symbol]} if symbol in today else {}


def test_refresh_publishes_a_board_of_the_session(tmp_path: Path, seed_watchlist) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    seed_watchlist(sectors.watchlist, "BE")

    result = sectors.refresh("us", clock["now"])
    assert (result.published, result.problem) == (True, None)

    board = sectors.boards.load("us")
    assert board is not None
    assert board.session_date == SESSION
    assert board.complete is False
    assert board.as_of == datetime(2026, 11, 6, 16, 0, tzinfo=UTC)
    assert board.times[0] == US_OPEN and board.times[-1] == datetime(
        2026, 11, 6, 15, 55, tzinfo=UTC
    )
    assert board.rank_sessions == [*PRIOR[1:], SESSION]
    assert (board.member_count, board.priced_count) == (3, 3)
    assert board.source == SectorSource(
        universe="Synthetic US index",
        fund="Synthetic UCITS ETF",
        fund_ticker="SYN",
        url="https://example.invalid/synthetic",
        as_of="2026-11-05",
    )
    assert board.exposure_gbp == 0.0 and board.exposure_basis_gbp is None
    assert [grouping.kind for grouping in board.groupings] == ["gics"]
    financials, technology = board.groupings[0].groups
    assert (financials.key, technology.key) == ("40", "45")
    assert technology.name == "Information Technology"
    assert technology.weight == pytest.approx(0.8)
    assert technology.change == pytest.approx((0.5 * 0.04 + 0.3 * -0.01) / 0.8)
    assert len(technology.path) == len(board.times)
    assert len(technology.ranks) == len(board.rank_sessions)
    by_symbol = {member.symbol: member for member in technology.members}
    assert by_symbol["AAA"].name == "Alpha Synthetic Inc."
    assert by_symbol["BE"].name == "SYNTHETIC BE"
    assert by_symbol["BE"].research_ticker == "BE"
    assert by_symbol["AAA"].research_ticker is None
    # Daily closes are fetched once per session when every symbol came back.
    assert sectors.refresh("us", clock["now"]).published
    assert len(prices.daily_requests) == 1


def test_official_closes_complete_a_board_after_the_close(tmp_path: Path) -> None:
    universes, prices = us_board_inputs(official=True)
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    # During the session, the day's daily bar is only its live price.
    prices.history["AAA"] = history("AAA", [90.0, 91.0, 92.0, 93.0, 100.0], close=999.0)
    assert sectors.refresh("us", clock["now"]).published

    prices.history["AAA"] = history("AAA", [90.0, 91.0, 92.0, 93.0, 100.0], close=105.0)
    clock["now"] = US_CLOSE + timedelta(minutes=30)
    result = sectors.refresh("us", clock["now"])

    assert (result.published, result.problem) == (True, None)
    board = sectors.boards.load("us")
    assert board is not None and board.complete is True
    assert board.as_of == US_CLOSE
    assert board.times[-1] == US_CLOSE
    members = {m.symbol: m for g in board.groupings[0].groups for m in g.members}
    assert members["AAA"].change == pytest.approx(0.05)
    assert members["CCC"].change == pytest.approx(0.02)
    assert not sectors.due("us", clock["now"])


def test_stale_prices_after_the_close_are_not_final(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()  # bars stop at 15:55, no official closes
    clock = {"now": US_CLOSE + timedelta(minutes=30)}
    sectors = monitor(tmp_path, universes, prices, clock)

    result = sectors.refresh("us", clock["now"])

    assert result.published is True
    assert (
        result.problem == "Closing prices cover 0% of the Synthetic US index weight for 2026-11-06"
    )
    board = sectors.boards.load("us")
    assert board is not None and board.complete is False
    assert sectors.due("us", clock["now"])
    state = sectors.run_once()
    assert state.phase == "error"
    assert state.last_error is not None and "Closing prices cover 0%" in state.last_error
    stored = json.loads((tmp_path / "state" / "sector-monitor.json").read_text())
    assert stored["markets"]["us"]["lastSuccessAt"] == "2026-11-06T21:30:00+00:00"


def test_a_sector_without_closing_prices_stays_unranked_on_a_complete_board(
    tmp_path: Path,
) -> None:
    universes = FakeUniverses(
        us=universe(
            "us",
            constituent("AAA", 0.5),
            constituent("BE", 0.4),
            constituent("CCC", 0.1, sector="40"),
        )
    )
    prices = FakePrices(
        intraday={
            "AAA": series("AAA", 100.0, [(0, 100.5), (385, 101.0)]),
            "BE": series("BE", 50.0, [(0, 50.0), (385, 50.4)]),
            # Financials stopped printing at the open, up 10%, and lack an official close.
            "CCC": series("CCC", 20.0, [(0, 22.0)]),
        },
        daily={
            "AAA": history("AAA", [90.0, 91.0, 92.0, 93.0, 100.0], close=101.0),
            "BE": history("BE", [50.0, 50.0, 49.0, 52.0, 50.0], close=50.5),
            "CCC": history("CCC", [20.0, 21.0, 20.0, 20.0, 20.0]),
        },
    )
    clock = {"now": US_CLOSE + timedelta(minutes=30)}
    sectors = monitor(tmp_path, universes, prices, clock)

    result = sectors.refresh("us", clock["now"])

    assert (result.published, result.problem) == (True, None)
    board = sectors.boards.load("us")
    assert board is not None and board.complete is True  # 90% closed at the close
    financials, technology = board.groupings[0].groups
    assert financials.change == pytest.approx(0.1)  # still shown
    assert (financials.ranks[-1], financials.streak) == (None, 0)
    assert None not in financials.ranks[:-1]  # earlier sessions rank on daily closes
    assert technology.ranks[-1] == 1


def test_older_prices_never_replace_a_newer_board(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    assert sectors.refresh("us", clock["now"]).published
    path = sectors.boards.path("us")
    before = path.read_bytes()

    # The provider now serves an older snapshot: bars up to 14:35 only.
    older = {
        symbol: series(symbol, item.previous_close or 1.0, [(0, item.closes[0])])
        for symbol, item in prices.quotes.items()
    }
    current = prices.quotes
    prices.quotes = older
    clock["now"] = datetime(2026, 11, 6, 16, 10, tzinfo=UTC)
    result = sectors.refresh("us", clock["now"])

    assert (result.published, result.stale) == (False, True)
    assert path.read_bytes() == before

    # An older snapshot leaves the market's reported problem as it was.
    prices.quotes = {"BE": current["BE"]}
    sectors.run_once()
    prices.quotes = older
    clock["now"] = datetime(2026, 11, 6, 16, 20, tzinfo=UTC)
    sectors.run_once()
    stored = json.loads((tmp_path / "state" / "sector-monitor.json").read_text())
    assert stored["markets"]["us"]["lastError"].startswith("Prices cover 30%")
    assert path.read_bytes() == before


def test_refresh_waits_without_error_within_the_opening_grace(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": US_OPEN + timedelta(minutes=10)}
    sectors = monitor(tmp_path, universes, FakePrices(), clock)

    assert sectors.refresh("us", clock["now"]).published is False
    assert sectors.boards.load("us") is None

    thin = FakePrices(intraday={"BE": prices.quotes["BE"]})
    sectors.prices = thin
    assert sectors.refresh("us", clock["now"]).published is False
    assert sectors.boards.load("us") is None


def test_no_prices_after_the_opening_grace_is_a_failure(tmp_path: Path) -> None:
    universes, _ = us_board_inputs()
    clock = {"now": US_OPEN + timedelta(minutes=40)}
    sectors = monitor(tmp_path, universes, FakePrices(), clock)

    with pytest.raises(SectorRefreshError, match="No prices yet for the 2026-11-06 session"):
        sectors.refresh("us", clock["now"])


def test_thin_coverage_later_keeps_the_previous_board_and_reports_it(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    assert sectors.refresh("us", clock["now"]).published
    path = sectors.boards.path("us")
    before = path.read_bytes()

    sectors.prices = FakePrices(intraday={"BE": prices.quotes["BE"]})
    clock["now"] = datetime(2026, 11, 6, 16, 10, tzinfo=UTC)
    with pytest.raises(SectorRefreshError, match="30% of the Synthetic US index weight"):
        sectors.refresh("us", clock["now"])
    assert path.read_bytes() == before

    state = sectors.run_once()
    assert state.phase == "error"
    assert state.last_error is not None and state.last_error.startswith("US: Prices cover 30%")
    stored = json.loads((tmp_path / "state" / "sector-monitor.json").read_text())
    assert stored["markets"]["us"]["lastError"].startswith("Prices cover 30%")
    assert stored["markets"]["us"]["lastErrorAt"] == "2026-11-06T16:10:00+00:00"
    us_status = next(status for status in sectors.markets(clock["now"]) if status.market == "us")
    assert us_status.last_error is not None and us_status.session_date == SESSION

    sectors.prices = prices
    clock["now"] = datetime(2026, 11, 6, 16, 20, tzinfo=UTC)
    recovered = sectors.run_once()
    # The other synthetic markets have no prices at all, which is reported too.
    assert recovered.last_error is not None and "US:" not in recovered.last_error
    assert "UK: No prices yet for the 2026-11-06 session" in recovered.last_error
    stored = json.loads((tmp_path / "state" / "sector-monitor.json").read_text())
    assert stored["markets"]["us"]["lastError"] is None
    assert stored["markets"]["us"]["lastSuccessAt"] == "2026-11-06T16:20:00+00:00"


def test_backfill_without_prices_is_reported_and_bounded(tmp_path: Path) -> None:
    universes, _ = us_board_inputs()
    prices = FakePrices()
    clock = {"now": datetime(2026, 11, 7, 12, tzinfo=UTC)}  # Saturday, no boards
    sectors = monitor(tmp_path, universes, prices, clock)

    for attempt in range(BACKFILL_ATTEMPTS):
        assert sectors.due("us", clock["now"]), attempt
        state = sectors.run_once()
        assert state.last_error is not None
        assert "US: No prices for the 2026-11-06 session" in state.last_error
        clock["now"] += timedelta(minutes=10)

    assert not any(sectors.due(market, clock["now"]) for market in ("us", "uk", "hk", "kr"))
    requests = len(prices.intraday_requests)
    sectors.run_once()
    assert len(prices.intraday_requests) == requests
    assert sectors.status().next_run_at == datetime(2026, 11, 9, tzinfo=UTC)


def test_a_late_fill_retries_an_unsettled_close(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()  # bars stop before the close; no official closes yet
    _, official = us_board_inputs(official=True)
    clock = {"now": datetime(2026, 11, 7, 12, tzinfo=UTC)}  # a restart long after the close
    sectors = monitor(tmp_path, universes, prices, clock)

    state = sectors.run_once()
    board = sectors.boards.load("us")
    assert board is not None and (board.session_date, board.complete) == (SESSION, False)
    assert state.last_error is not None and "US: Closing prices cover 0%" in state.last_error
    assert sectors.due("us", clock["now"])

    # The provider's closes arrive by the next slot: the board settles and the market rests.
    prices.history = official.history
    clock["now"] += timedelta(minutes=10)
    sectors.run_once()
    board = sectors.boards.load("us")
    assert board is not None and board.complete is True
    assert board.as_of == US_CLOSE
    assert not sectors.due("us", clock["now"])


def test_an_unsettled_close_is_retried_only_a_few_times(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()  # official closes never arrive
    clock = {"now": datetime(2026, 11, 7, 12, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)

    for attempt in range(BACKFILL_ATTEMPTS):
        assert sectors.due("us", clock["now"]), attempt
        sectors.run_once()
        clock["now"] += timedelta(minutes=10)

    board = sectors.boards.load("us")
    assert board is not None and board.complete is False
    assert not sectors.due("us", clock["now"])
    requests = len(prices.intraday_requests)
    sectors.run_once()
    assert len(prices.intraday_requests) == requests


def test_a_late_fill_asks_again_for_closes_the_window_gave_up_on(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()  # the session's official closes are late
    _, official = us_board_inputs(official=True)
    clock = {"now": US_CLOSE + COMPLETE_AFTER}
    sectors = monitor(tmp_path, universes, prices, clock)

    # Within the window the closes are asked for a few times, then no more.
    for minute in (30, 40, 50, 60):
        clock["now"] = US_CLOSE + timedelta(minutes=minute)
        sectors.run_once()
    requests = len(prices.daily_requests)
    clock["now"] = US_CLOSE + timedelta(minutes=70)
    sectors.run_once()
    assert len(prices.daily_requests) == requests

    # Past the window, the first late attempt asks again and settles the session.
    prices.history = official.history
    clock["now"] = US_CLOSE + COMPLETE_AFTER + GIVE_UP_AFTER + timedelta(minutes=10)
    sectors.run_once()
    assert len(prices.daily_requests) == requests + 1
    board = sectors.boards.load("us")
    assert board is not None and board.complete is True


def test_a_late_fill_never_replaces_a_settled_board_with_an_unsettled_one(
    tmp_path: Path,
) -> None:
    universes, official = us_board_inputs(official=True)
    clock = {"now": US_CLOSE + COMPLETE_AFTER}
    earlier = monitor(tmp_path, universes, official, clock)
    assert earlier.refresh("us", clock["now"]).problem is None
    settled = earlier.boards.load("us")
    assert settled is not None and settled.complete
    # Stored as the previous session's settled board.
    earlier.boards.save(settled.model_copy(update={"session_date": PRIOR[-1]}))

    _, prices = us_board_inputs()  # the latest session's closes are missing
    clock["now"] = datetime(2026, 11, 7, 12, tzinfo=UTC)  # a restart long after the close
    sectors = monitor(tmp_path, universes, prices, clock)
    state = sectors.run_once()
    kept = sectors.boards.load("us")
    assert kept is not None and (kept.session_date, kept.complete) == (PRIOR[-1], True)
    assert state.last_error is not None and "US: Closing prices cover 0%" in state.last_error
    assert sectors.due("us", clock["now"])

    prices.history = official.history
    clock["now"] += timedelta(minutes=10)
    sectors.run_once()
    board = sectors.boards.load("us")
    assert board is not None and (board.session_date, board.complete) == (SESSION, True)


def test_missing_daily_closes_are_asked_for_again(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    complete_history = dict(prices.history)
    prices.history = {"AAA": complete_history["AAA"]}
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)

    assert sectors.refresh("us", clock["now"]).published
    first = sectors.boards.load("us")
    assert first is not None
    financials = next(group for group in first.groupings[0].groups if group.key == "40")
    assert financials.ranks[:-1] == [None, None, None, None]

    prices.history = complete_history
    clock["now"] = datetime(2026, 11, 6, 16, 10, tzinfo=UTC)
    assert sectors.refresh("us", clock["now"]).published
    assert prices.daily_requests[-1] == ["BE", "CCC"]
    second = sectors.boards.load("us")
    assert second is not None
    financials = next(group for group in second.groupings[0].groups if group.key == "40")
    assert None not in financials.ranks

    # A symbol that never comes back is asked for a few times, then left alone.
    prices.quotes["NEW"] = series("NEW", 1.0, [(0, 1.0)])
    sectors.universes = FakeUniverses(
        us=universe("us", *universes.markets["us"].constituents, constituent("NEW", 0.01))
    )
    for minute in (20, 30, 40, 50, 60):
        clock["now"] = datetime(2026, 11, 6, 16, 0, tzinfo=UTC) + timedelta(minutes=minute)
        sectors.refresh("us", clock["now"])
    assert sum(request == ["NEW"] for request in prices.daily_requests) == 3


def write_security_master(root: Path, records: list[SecurityEntityRecord]) -> None:
    path = root / "reference" / "security-master.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        SecurityMasterCatalog(schema_version=3, records=records).model_dump_json(by_alias=True)
    )


def gics(sector: str, group: str, name: str) -> GicsClassification:
    return GicsClassification(
        sector_code=sector,
        sector_name="Synthetic",
        industry_group_code=group,
        industry_group_name=name,
        source="synthetic-test",
        version="2026",
    )


def publish(store: ArtifactStore, payloads: dict[str, object]):
    return store.publish_typed(
        scope="all",
        source="synthetic-sector-test",
        artifacts=[
            store.immutable_artifacts.put_json(key=key, payload=value)
            for key, value in payloads.items()
        ],
    )


def test_exposure_follows_issuers_and_industry_groups_respect_the_sector(tmp_path: Path) -> None:
    write_security_master(
        tmp_path,
        [
            SecurityEntityRecord(
                entity_id="syn-alpha",
                canonical_ticker="AAA",
                entity_name="Alpha Synthetic",
                isins=["US00000000A1", "US00000000A2"],
                gics=gics("45", "4530", "Semiconductors & Semiconductor Equipment"),
                source="synthetic-test",
            ),
            SecurityEntityRecord(
                entity_id="syn-beta",
                canonical_ticker="BBB",
                entity_name="Beta Synthetic",
                isins=["US00000000B1"],
                gics=gics("40", "4010", "Banks"),
                source="synthetic-test",
            ),
        ],
    )
    store = ArtifactStore(tmp_path)
    publish(
        store,
        {
            "account/lookthrough_metrics.json": {
                "investedValueGbp": 1000.0,
                "positions": [
                    {"entityId": "syn-alpha", "isin": None, "ticker": "AAA", "valueGbp": 300.0},
                    {"entityId": "syn-beta", "isin": None, "ticker": "BBB", "valueGbp": 50.0},
                    {
                        "entityId": "unresolved:synthetic",
                        "isin": "US00000000C1",
                        "ticker": "CCC",
                        "valueGbp": 20.0,
                    },
                    {
                        "entityId": "unresolved:synthetic-alpha",
                        "isin": "US00000000A1",
                        "ticker": "AAA",
                        "valueGbp": 30.0,
                    },
                ],
            }
        },
    )
    universes = FakeUniverses(
        us=universe(
            "us",
            constituent("AAA", 0.4, isin="US00000000A1"),
            constituent("AAB", 0.2, isin="US00000000A2"),
            constituent("BBB", 0.3, isin="US00000000B1"),
            constituent("CCC", 0.1, sector="40", isin="US00000000C1"),
        )
    )
    prices = FakePrices(
        intraday={
            symbol: series(symbol, 10.0, [(0, 10.1)]) for symbol in ("AAA", "AAB", "BBB", "CCC")
        }
    )
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = SectorMonitor(
        tmp_path,
        store,
        WatchlistStore(tmp_path),
        available=True,
        enabled=True,
        universes=universes,
        prices=prices,
        now=lambda: clock["now"],
    )

    assert sectors.refresh("us", clock["now"]).published

    board = sectors.boards.load("us")
    assert board is not None
    members = {
        member.symbol: member for group in board.groupings[0].groups for member in group.members
    }
    # The issuer's value splits by weight; its unresolved ISIN row adds to AAA once.
    assert members["AAA"].exposure_gbp == pytest.approx(230.0)
    assert members["AAB"].exposure_gbp == pytest.approx(100.0)
    assert members["BBB"].exposure_gbp == pytest.approx(50.0)
    assert members["CCC"].exposure_gbp == pytest.approx(20.0)
    assert (members["AAA"].subgroup, members["BBB"].subgroup, members["CCC"].subgroup) == (
        "4530",
        "",
        "",
    )
    technology = next(group for group in board.groupings[0].groups if group.key == "45")
    assert [(sub.key, sub.name) for sub in technology.subgroups] == [
        ("4530", "Semiconductors & Semiconductor Equipment"),
        ("", ""),
    ]
    assert technology.subgroups[1].member_count == 1
    assert technology.exposure_gbp == pytest.approx(380.0)
    assert board.exposure_gbp == pytest.approx(400.0)
    assert board.exposure_basis_gbp == 1000.0


def themed_item(
    ticker: str, theme: str, exchange: str = "NASDAQ", bloomberg: str = ""
) -> WatchlistItem:
    return WatchlistItem(
        ticker=ticker,
        name=f"Synthetic {ticker}",
        exchange=exchange,
        bloomberg_ticker=bloomberg,
        figi=f"BBGSYNTH{ticker}",
        category_id=theme,
        research_theme_id=theme,
        taxonomy_status="assigned",
    )


def test_themes_admit_only_listings_with_a_us_venue() -> None:
    themes = [WatchlistCategory(id="t", label_zh="主题", label_en="Theme")]
    state = WatchlistState(
        categories=themes,
        research_themes=themes,
        items=[
            themed_item("AAA", "t"),
            themed_item("BBB", "t", exchange="US"),
            themed_item("CCC", "t", exchange="NYQ"),
            themed_item("ASML", "t", exchange="AMS"),
            themed_item("SAP", "t", exchange=""),
            themed_item("HSBA.L", "t", exchange="US"),
            # The watchlist's default Bloomberg label is no evidence beside a named exchange.
            themed_item("SYN", "t", exchange="Toronto Stock Exchange", bloomberg="SYN US Equity"),
        ],
    )
    grouping = theme_grouping(state, CatalogSecurityMaster.default(), PortfolioExposure())
    assert [member.symbol for member in grouping.members] == ["AAA", "BBB", "CCC"]


def test_theme_caps_fall_back_on_us_listings_only() -> None:
    themes = [
        WatchlistCategory(id="sized", label_zh="有市值", label_en="Sized", order=1),
        WatchlistCategory(id="unsized", label_zh="无市值", label_en="Unsized", order=2),
    ]
    state = WatchlistState(
        categories=themes,
        research_themes=themes,
        items=[
            themed_item("AAA", "sized"),
            themed_item("BBB", "sized"),
            themed_item("CCC", "sized"),
            themed_item("XXX", "unsized"),
            themed_item("YYY", "unsized"),
            themed_item("ZZZ", "unsized"),
            themed_item("005930.KS", "unsized", exchange="KSC"),  # not a US listing
        ],
    )
    portfolio = PortfolioExposure(
        market_caps={
            "AAA": 1.0e11,
            "BBB": 2.0e11,
            "CCC": 3.0e11,
            # Caps in won and yen dwarf dollar caps; they never size a US theme.
            "005930.KS": 4.0e14,
            "000660.KS": 9.0e13,
            "7203.T": 4.5e13,
            "6758.T": 2.0e13,
        }
    )

    grouping = theme_grouping(state, CatalogSecurityMaster.default(), portfolio)

    weights = {member.symbol: member.weight for member in grouping.members}
    # A theme without any known cap takes the median of the themed US listings' caps.
    assert weights == pytest.approx(
        {"AAA": 1.0e11, "BBB": 2.0e11, "CCC": 3.0e11, "XXX": 2.0e11, "YYY": 2.0e11, "ZZZ": 2.0e11}
    )


def test_us_board_adds_research_themes_with_enough_priced_members(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path)
    publish(
        store,
        {
            "research/fundamentals.json": {
                "rows": [
                    {"ticker": "AAA", "metrics": {"marketCap": 3.0e11}},
                    {"ticker": "XXX", "metrics": {"marketCap": 1.0e11}},
                ]
            }
        },
    )
    watchlist = WatchlistStore(tmp_path)
    themes = [
        WatchlistCategory(id="compute", label_zh="算力", label_en="Compute", order=1),
        WatchlistCategory(id="pair", label_zh="两只", label_en="Pair", order=2),
        WatchlistCategory(id="thin", label_zh="稀疏", label_en="Thin", order=3),
    ]
    watchlist.save(
        WatchlistState(
            categories=themes,
            research_themes=themes,
            items=[
                themed_item("AAA", "compute"),
                themed_item("XXX", "compute"),
                themed_item("YYY", "compute"),
                themed_item("PP1", "pair"),
                themed_item("PP2", "pair"),
                themed_item("TT1", "thin"),
                themed_item("TT2", "thin"),
                themed_item("TT3", "thin"),
            ],
        )
    )
    universes = FakeUniverses(us=universe("us", constituent("AAA", 1.0)))
    priced = ("AAA", "XXX", "YYY", "PP1", "PP2", "TT1", "TT2")
    prices = FakePrices(intraday={symbol: series(symbol, 10.0, [(0, 10.2)]) for symbol in priced})
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = SectorMonitor(
        tmp_path,
        store,
        watchlist,
        available=True,
        enabled=True,
        universes=universes,
        prices=prices,
        now=lambda: clock["now"],
    )

    assert sectors.refresh("us", clock["now"]).published

    board = sectors.boards.load("us")
    assert board is not None
    assert [grouping.kind for grouping in board.groupings] == ["gics", "themes"]
    (compute,) = board.groupings[1].groups
    assert (compute.key, compute.name, compute.name_zh) == ("compute", "Compute", "算力")
    weights = {member.symbol: member.weight for member in compute.members}
    # YYY has no market cap and takes the theme's median.
    assert weights == pytest.approx({"AAA": 0.5, "YYY": 1 / 3, "XXX": 1 / 6})
    assert {member.research_ticker for member in compute.members} == {"AAA", "XXX", "YYY"}
    assert compute.change == pytest.approx(0.02)
    assert compute.subgroups == []
    # Theme members outside the index are priced in the same requests.
    assert set(prices.intraday_requests[0]) >= {"AAA", "XXX", "YYY", "TT3"}
    assert "PP1" not in prices.intraday_requests[0]


def test_rate_limiting_pauses_every_market(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    prices.raise_intraday = SparkRateLimited("Yahoo Finance is rate-limiting price requests")
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)

    state = sectors.run_once()

    assert state.phase == "error"
    assert len(prices.intraday_requests) == 1
    assert not any(sectors.due(market, clock["now"]) for market in ("us", "uk", "hk", "kr"))
    assert state.next_run_at == datetime(2026, 11, 6, 16, 30, tzinfo=UTC)
    clock["now"] = datetime(2026, 11, 6, 16, 31, tzinfo=UTC)
    assert sectors.due("us", clock["now"])


def test_the_next_run_waits_out_a_pause_that_outlasts_a_lunch_break(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    prices.raise_intraday = SparkRateLimited("Yahoo Finance is rate-limiting price requests")
    # Monday 04:40 UTC: Hong Kong at lunch until 05:00; a late US fill meets a rate limit.
    clock = {"now": datetime(2026, 11, 9, 4, 40, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)

    state = sectors.run_once()

    assert len(prices.intraday_requests) == 1
    assert state.next_run_at == datetime(2026, 11, 9, 5, 10, tzinfo=UTC)


def test_switching_off_stops_a_refresh_before_it_publishes(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    prices.on_intraday = lambda: sectors.configure(enabled=False)

    with pytest.raises(SectorRefreshCancelled):
        sectors.refresh("us", clock["now"])
    assert sectors.boards.load("us") is None

    sectors.configure(enabled=True)
    state = sectors.run_once()  # switched off again during the first market
    assert sectors.boards.load("us") is None
    assert len(prices.intraday_requests) == 2  # no later market was started
    assert state.last_error is None
    stored = json.loads((tmp_path / "state" / "sector-monitor.json").read_text())
    assert stored["markets"] == {}
    assert sectors.status().phase == "disabled"


class SwitchingStore:
    """A snapshot store whose read runs a hook, such as Settings switching the monitor off."""

    def __init__(self) -> None:
        self.on_read: Callable[[], None] | None = None

    def latest_manifest(self) -> None:
        if self.on_read is not None:
            self.on_read()


def test_switching_off_while_inputs_are_prepared_sends_no_price_request(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    store = SwitchingStore()
    sectors = SectorMonitor(
        tmp_path,
        store,
        WatchlistStore(tmp_path),
        available=True,
        enabled=True,
        universes=universes,
        prices=prices,
        now=lambda: clock["now"],
    )
    # Switched off while the portfolio exposure is read.
    store.on_read = lambda: sectors.configure(enabled=False)

    with pytest.raises(SectorRefreshCancelled):
        sectors.refresh("us", clock["now"])
    sectors.configure(enabled=True)
    state = sectors.run_once()

    assert (prices.intraday_requests, prices.daily_requests) == ([], [])
    assert sectors.boards.load("us") is None
    assert state.last_error is None


def test_switching_off_before_daily_closes_sends_no_daily_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    session_dates = sector_monitor.prior_session_dates

    def switching_off(*args: object, **kwargs: object) -> list[str]:
        # Switched off while the earlier sessions are looked up, after the intraday prices.
        sectors.configure(enabled=False)
        return session_dates(*args, **kwargs)

    monkeypatch.setattr(sector_monitor, "prior_session_dates", switching_off)

    with pytest.raises(SectorRefreshCancelled):
        sectors.refresh("us", clock["now"])
    assert len(prices.intraday_requests) == 1
    assert prices.daily_requests == []
    assert sectors.boards.load("us") is None


def test_shutdown_stops_a_refresh_between_steps(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock)
    universes.on_get = lambda market: sectors.close()

    sectors.run_once()

    assert prices.intraday_requests == []
    assert sectors.boards.load("us") is None
    with pytest.raises(SectorRefreshCancelled):
        sectors.refresh("uk", clock["now"])


def complete_board(market: str, session_date: str) -> SectorBoard:
    return SectorBoard(
        market=market,
        session_date=session_date,
        complete=True,
        fetched_at=datetime(2026, 11, 7, 1, tzinfo=UTC),
        source=SectorSource(
            universe="Synthetic", fund="Synthetic", fund_ticker="SYN", url="", as_of=""
        ),
    )


def test_status_reports_schedule_and_switches(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 3, tzinfo=UTC)}
    off = monitor(tmp_path, universes, prices, clock, enabled=False).status()
    assert (off.enabled, off.phase, off.next_run_at) == (False, "disabled", None)
    unavailable = SectorMonitor(
        tmp_path,
        ArtifactStore(tmp_path),
        WatchlistStore(tmp_path),
        available=False,
        enabled=True,
        universes=universes,
        prices=prices,
        now=lambda: clock["now"],
    ).status()
    assert (unavailable.enabled, unavailable.phase) == (False, "disabled")

    sectors = monitor(tmp_path, universes, prices, clock)
    starting = sectors.status()
    assert (starting.enabled, starting.phase, starting.interval_seconds) == (True, "starting", 600)
    assert starting.next_run_at == datetime(2026, 11, 6, 16, 10, tzinfo=UTC)

    for market in ("us", "uk", "hk", "kr"):
        sectors.boards.save(complete_board(market, SESSION))
    clock["now"] = datetime(2026, 11, 7, 12, tzinfo=UTC)
    assert sectors.status().next_run_at == datetime(2026, 11, 9, tzinfo=UTC)
    assert sectors.run_once().phase == "idle"


def test_configure_switches_the_monitor_and_reruns_the_current_slot(tmp_path: Path) -> None:
    universes, prices = us_board_inputs()
    clock = {"now": datetime(2026, 11, 6, 16, 0, tzinfo=UTC)}
    sectors = monitor(tmp_path, universes, prices, clock, enabled=False)
    assert sectors._tick() == 3600.0

    sectors.configure(enabled=True)
    delay = sectors._tick()
    assert sectors.boards.load("us") is not None
    assert 1.0 <= delay <= 60.0
    requests = len(prices.intraday_requests)
    sectors._tick()
    assert len(prices.intraday_requests) == requests


@pytest.mark.parametrize("has_prior", [True, False])
def test_hong_kong_needs_the_exact_dated_previous_close(tmp_path: Path, has_prior: bool) -> None:
    symbol = "0123.HK"
    session = latest_session("hk", datetime(2026, 11, 6, 3, tzinfo=UTC))
    assert session is not None
    days = {"2026-11-04": 95, "2026-11-06": 103}
    if has_prior:
        days["2026-11-05"] = 100
    prices = FakePrices(
        {symbol: series(symbol, 200, [(5, 101)], opened=session.open)},
        {
            symbol: SparkSeries(
                symbol,
                tuple(
                    int(datetime.fromisoformat(f"{day}T01:30:00+00:00").timestamp()) for day in days
                ),
                tuple(days.values()),
            )
        },
    )
    clock = {"now": datetime(2026, 11, 6, 3, tzinfo=UTC)}
    sectors = monitor(
        tmp_path, FakeUniverses(hk=universe("hk", constituent(symbol, 1))), prices, clock
    )
    if not has_prior:
        with pytest.raises(SectorRefreshError, match="No prices yet"):
            sectors.refresh("hk", clock["now"])
        assert sectors.boards.load("hk") is None
        return
    assert sectors.refresh("hk", clock["now"]).published
    board = sectors.boards.load("hk")
    assert board is not None
    assert board.groupings[0].groups[0].change == pytest.approx(0.01)
    assert sectors.refresh("hk", clock["now"]).published
    assert prices.daily_requests == [[symbol]]
