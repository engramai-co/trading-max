"""Ten-minute sector boards for the markets that are trading.

Every ten-minute slot refreshes each market whose session is under way, and
once more after the close so the board ends on official closing prices. A
market without a board is filled from its latest session at once, a few
times at most. A refresh that prices too little of the index keeps the
previous board and records the failure; prices that have not started within
the opening grace are a failure too. Switching the monitor off or shutting
down stops a refresh between its steps, and always before the next request to
a provider.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol
from zoneinfo import ZoneInfo

from trading_max.analytics.sector_board import (
    BoardMember,
    GroupLabel,
    MemberSession,
    board_as_of,
    board_times,
    build_grouping,
    closes_at_close,
    member_session,
    settle,
)
from trading_max.infrastructure.durable_files import atomic_bytes
from trading_max.infrastructure.sector_prices import (
    SparkRateLimited,
    SparkSeries,
    YahooSparkPrices,
)
from trading_max.infrastructure.sector_universe import (
    GICS_SECTORS,
    SectorUniverse,
    SectorUniverseProvider,
)

from .models import SectorMonitorState
from .sector_context import (
    MIN_THEME_MEMBERS,
    PortfolioExposure,
    Resolution,
    SecurityMasterCache,
    member_key,
    portfolio_exposure,
    research_index,
    resolve_constituents,
    shared_exposure,
    theme_grouping,
)
from .sector_models import (
    SectorBoard,
    SectorBoardResponse,
    SectorGrouping,
    SectorMarketCode,
    SectorMarketStatus,
    SectorSessionWindow,
    SectorSource,
)
from .sector_sessions import (
    COMPLETE_AFTER,
    GIVE_UP_AFTER,
    MARKETS,
    board_complete,
    in_break,
    is_due,
    latest_session,
    next_session,
    prior_session_dates,
    sessions_between,
)

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .watchlist import WatchlistStore

LOGGER = logging.getLogger(__name__)

SLOT_SECONDS = 600
# A board is published, and later counted final, only when prices (then
# closing prices) cover this share of the index weight.
MIN_COVERAGE = 0.8
# Thin coverage just after the open is the open itself (and up to twenty
# minutes of provider delay), not a failure.
OPEN_GRACE = timedelta(minutes=30)
# After Yahoo asks for fewer requests, every market pauses this long.
RATE_LIMIT_PAUSE = timedelta(minutes=30)
# Daily closes a provider leaves out are asked for again this many times a session.
DAILY_ATTEMPTS = 3
RANK_SESSIONS = 4
SESSION_WINDOW = timedelta(days=7)
SECTOR_NAMES = {code: name for name, code in GICS_SECTORS.items()}


class UniverseSource(Protocol):
    def get(self, market: str) -> SectorUniverse: ...


class PriceSource(Protocol):
    def intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]: ...

    def daily(self, symbols: Iterable[str]) -> dict[str, SparkSeries]: ...


class SectorRefreshError(RuntimeError):
    """A refresh could not produce a board worth publishing."""


class SectorRefreshCancelled(RuntimeError):
    """The monitor was switched off or is shutting down."""


@dataclass(frozen=True, slots=True)
class RefreshResult:
    """What one market refresh achieved.

    `stale` means the provider returned older prices than the stored board,
    which stays; `problem` is a shortfall to report beside a published board.
    """

    published: bool
    problem: str | None = None
    stale: bool = False


class SectorBoardStore:
    """The latest board of each market, written atomically and parsed once per change."""

    def __init__(self, data_root: Path) -> None:
        self.root = data_root / "state" / "sectors"
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[tuple[int, int, int] | None, SectorBoard | None]] = {}

    def path(self, market: str) -> Path:
        return self.root / f"{market}.json"

    def load(self, market: str) -> SectorBoard | None:
        path = self.path(market)
        try:
            stat = path.stat()
        except FileNotFoundError:
            signature = None
        else:
            signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._cache.get(market)
            if cached is not None and cached[0] == signature:
                return cached[1]
        board = None
        if signature is not None:
            try:
                board = SectorBoard.model_validate_json(path.read_bytes())
            except (OSError, ValueError):
                LOGGER.warning("sector board is unreadable", extra={"market": market})
        with self._lock:
            self._cache[market] = (signature, board)
        return board

    def save(self, board: SectorBoard) -> None:
        atomic_bytes(self.path(board.market), board.model_dump_json(by_alias=True).encode("utf-8"))


@dataclass(slots=True)
class _DailyCloses:
    """Daily closes and names for one market session.

    Closes fetched during the session carry its live price; `final` marks
    closes fetched after it, which hold its official close.
    """

    session: str
    final: bool = False
    closes: dict[str, dict[str, float]] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)
    misses: dict[str, int] = field(default_factory=dict)

    def satisfied(self, symbol: str) -> bool:
        closes = self.closes.get(symbol)
        return closes is not None and (not self.final or self.session in closes)


def default_market(statuses: Iterable[SectorMarketStatus], now: datetime) -> SectorMarketCode:
    """The market trading now with the most exposure, else the one that closed last."""

    order = list(MARKETS)
    statuses = list(statuses)
    trading = [
        status
        for status in statuses
        if any(window.open <= now < window.close for window in status.sessions)
    ]
    if trading:
        return max(
            trading, key=lambda status: (status.exposure_gbp, -order.index(status.market))
        ).market
    closed = [
        (close, -order.index(status.market), status.market)
        for status in statuses
        if (close := max((w.close for w in status.sessions if w.close <= now), default=None))
    ]
    return max(closed)[2] if closed else "us"


def _regresses(previous: SectorBoard, board: SectorBoard) -> bool:
    """Whether publishing `board` would replace newer prices with older ones."""

    if previous.session_date != board.session_date:
        return previous.session_date > board.session_date
    if previous.complete and not board.complete:
        return True
    return previous.as_of is not None and board.as_of is not None and board.as_of < previous.as_of


def _message(exc: Exception) -> str:
    text = str(exc) if isinstance(exc, SectorRefreshError) else f"{type(exc).__name__}: {exc}"
    return " ".join(text.split())[:300]


class SectorMonitor:
    """Refresh each market's sector board on ten-minute wall-clock slots."""

    def __init__(
        self,
        data_root: Path,
        store: ArtifactStore,
        watchlist: WatchlistStore,
        *,
        available: bool,
        enabled: bool,
        interval_seconds: int = SLOT_SECONDS,
        universes: UniverseSource | None = None,
        prices: PriceSource | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if interval_seconds < 60:
            raise ValueError("interval_seconds must be at least 60")
        self.store = store
        self.watchlist = watchlist
        self.available = available
        self.enabled = enabled
        self.interval_seconds = interval_seconds
        self.universes = universes or SectorUniverseProvider(data_root)
        self.prices = prices or YahooSparkPrices()
        self.boards = SectorBoardStore(data_root)
        self.masters = SecurityMasterCache(data_root)
        self.status_path = data_root / "state" / "sector-monitor.json"
        self._now = now or (lambda: datetime.now(UTC))
        self._lock = threading.RLock()
        self._state = self._read_state()
        self._phase = "starting"
        self._paused_until: datetime | None = None
        self._backfill: dict[str, tuple[str, int]] = {}
        self._daily: dict[str, _DailyCloses] = {}
        self._portfolio: tuple[str | None, PortfolioExposure] | None = None
        self._resolutions: dict[str, tuple[object, dict[str, Resolution]]] = {}
        self._last_slot: datetime | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    # Persistence -------------------------------------------------------

    def _read_state(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        if not isinstance(payload.get("markets"), dict):
            payload["markets"] = {}
        return payload

    def _write_state(self) -> None:
        payload = {**self._state, "schemaVersion": 1}
        atomic_bytes(
            self.status_path,
            (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(),
        )

    # Scheduling --------------------------------------------------------

    def _active(self) -> bool:
        return not self._stop.is_set() and self.available and self.enabled

    def _check_active(self) -> None:
        if not self._active():
            raise SectorRefreshCancelled("sector refreshes are switched off")

    def _slot(self, at: datetime) -> datetime:
        seconds = int(at.timestamp())
        return datetime.fromtimestamp(seconds - seconds % self.interval_seconds, UTC)

    def _ceil_slot(self, at: datetime) -> datetime:
        slot = self._slot(at)
        return slot if slot >= at else slot + timedelta(seconds=self.interval_seconds)

    def _backfill_attempts(self, market: str, session: SectorSessionWindow) -> int:
        recorded = self._backfill.get(market)
        return recorded[1] if recorded is not None and recorded[0] == session.date else 0

    def _due(self, market: SectorMarketCode, session: SectorSessionWindow, now: datetime) -> bool:
        board = self.boards.load(market)
        return is_due(
            session,
            board.session_date if board else None,
            bool(board and board.complete),
            now,
            backfill_attempts=self._backfill_attempts(market, session),
        )

    def due(self, market: SectorMarketCode, now: datetime) -> bool:
        if self._paused_until is not None and now < self._paused_until:
            return False
        session = latest_session(market, now)
        return session is not None and self._due(market, session, now)

    def next_run_at(self, now: datetime) -> datetime | None:
        """When the next refresh of any market is scheduled."""

        boundary = self._slot(now) + timedelta(seconds=self.interval_seconds)
        if self._paused_until is not None and now < self._paused_until:
            boundary = max(boundary, self._ceil_slot(self._paused_until))
        candidates: list[datetime] = []
        for market in MARKETS:
            session = latest_session(market, now)
            if session is not None and self._due(market, session, now):
                candidates.append(boundary)
                continue
            if session is not None and session.break_end is not None and in_break(session, now):
                candidates.append(self._ceil_slot(session.break_end))
                continue
            upcoming = next_session(market, now)
            if upcoming is not None:
                candidates.append(max(boundary, self._ceil_slot(upcoming.open)))
        return min(candidates, default=None)

    # Inputs ------------------------------------------------------------

    def _portfolio_exposure(self) -> PortfolioExposure:
        try:
            manifest = self.store.latest_manifest()
        except Exception:
            LOGGER.warning("latest snapshot unavailable for sector exposure", exc_info=True)
            manifest = None
        run_id = manifest.run_id if manifest is not None else None
        if self._portfolio is not None and self._portfolio[0] == run_id:
            return self._portfolio[1]
        portfolio = portfolio_exposure(self.store, manifest)
        self._portfolio = (run_id, portfolio)
        return portfolio

    def _resolved(self, market: str, universe: SectorUniverse) -> dict[str, Resolution]:
        key = (
            universe.fetched_at,
            tuple(constituent.symbol for constituent in universe.constituents),
            self.masters.signature(),
        )
        cached = self._resolutions.get(market)
        if cached is not None and cached[0] == key:
            return cached[1]
        resolved = resolve_constituents(self.masters.get(), universe.constituents)
        self._resolutions[market] = (key, resolved)
        return resolved

    def _daily_closes(
        self,
        market: SectorMarketCode,
        session_date: str,
        symbols: list[str],
        *,
        final: bool,
    ) -> _DailyCloses:
        """Daily closes for ranks, names, and after the close the official closes.

        A symbol the provider leaves out (or, after the close, returns without
        the session's close) is asked for again on later refreshes, a few times.
        """

        cached = self._daily.get(market)
        if cached is None or cached.session != session_date:
            cached = self._daily[market] = _DailyCloses(session_date)
        if final and not cached.final:
            # Closes fetched during the session carry its live price, not its close.
            cached.final = True
            cached.misses.clear()
            for closes in cached.closes.values():
                closes.pop(session_date, None)
        wanted = [
            symbol
            for symbol in symbols
            if not cached.satisfied(symbol) and cached.misses.get(symbol, 0) < DAILY_ATTEMPTS
        ]
        if not wanted:
            return cached
        self._check_active()
        try:
            series = self.prices.daily(wanted)
        except SparkRateLimited:
            raise
        except Exception as exc:
            # Earlier ranks are a refinement; the session board stands without them.
            LOGGER.warning(
                "daily sector prices unavailable", extra={"market": market, "error": _message(exc)}
            )
            series = {}
        zone = ZoneInfo(MARKETS[market].timezone)
        for symbol in wanted:
            item = series.get(symbol)
            if item is not None:
                cached.closes[symbol] = {
                    datetime.fromtimestamp(stamp, zone).date().isoformat(): close
                    for stamp, close in zip(item.timestamps, item.closes, strict=False)
                    if close is not None
                }
                if item.name:
                    cached.names[symbol] = item.name
            if not cached.satisfied(symbol):
                cached.misses[symbol] = cached.misses.get(symbol, 0) + 1
        return cached

    # Refresh -----------------------------------------------------------

    def refresh(self, market: SectorMarketCode, now: datetime) -> RefreshResult:
        """Refresh `market`'s board.

        Unpublished while its session's prices are still arriving within the
        opening grace, or when the provider returns older prices than the
        stored board. After the close, official daily closes settle each
        member, and the board is complete only once closing prices cover most
        of the index; a shortfall then is reported as a problem. A group whose
        own closing prices are too thin to rank it stays unranked that session.
        """

        self._check_active()
        session = latest_session(market, now)
        if session is None:
            raise SectorRefreshError("the exchange calendar has no recent session")
        universe = self.universes.get(market)
        self._check_active()
        portfolio = self._portfolio_exposure()
        resolved = self._resolved(market, universe)
        watchlist = self.watchlist.load()
        research = research_index(watchlist.items)
        themes = (
            theme_grouping(
                watchlist,
                self.masters.get(),
                portfolio,
                universe={
                    c.symbol: (resolved[c.symbol].entity_id, c.isin) for c in universe.constituents
                },
            )
            if market == "us"
            else None
        )
        symbols = list(
            dict.fromkeys(
                [constituent.symbol for constituent in universe.constituents]
                + ([member.symbol for member in themes.members] if themes else [])
            )
        )
        # Switching off while the inputs were prepared stops the refresh before
        # it asks the provider for anything.
        self._check_active()
        series = self.prices.intraday(symbols)
        fetched_at = self._now()
        self._check_active()
        sessions: dict[str, MemberSession] = {}
        for symbol, item in series.items():
            priced = member_session(
                item.timestamps,
                item.closes,
                item.previous_close,
                session_open=session.open,
                session_close=session.close,
            )
            if priced is not None:
                sessions[symbol] = priced

        def coverage() -> float:
            return sum(c.weight for c in universe.constituents if c.symbol in sessions)

        after_close = board_complete(session, fetched_at)
        if not after_close and coverage() < MIN_COVERAGE:
            if now < session.open + OPEN_GRACE:
                return RefreshResult(published=False)
            if coverage() <= 0:
                raise SectorRefreshError(f"No prices yet for the {session.date} session")
            raise SectorRefreshError(
                f"Prices cover {coverage():.0%} of the {universe.universe} weight for {session.date}"
            )

        daily_sessions = prior_session_dates(market, session.date, RANK_SESSIONS + 1)
        daily = self._daily_closes(market, session.date, symbols, final=after_close)
        self._check_active()
        if after_close:
            previous_date = daily_sessions[-1] if daily_sessions else ""
            for symbol in symbols:
                closes = daily.closes.get(symbol) or {}
                settled = settle(
                    sessions.get(symbol),
                    closes.get(session.date),
                    closes.get(previous_date),
                    session_close=session.close,
                )
                if settled is not None:
                    sessions[symbol] = settled
            if coverage() <= 0:
                raise SectorRefreshError(f"No prices for the {session.date} session")
            if coverage() < MIN_COVERAGE:
                raise SectorRefreshError(
                    f"Prices cover {coverage():.0%} of the {universe.universe} weight"
                    f" for {session.date}"
                )
        closing = sum(
            c.weight
            for c in universe.constituents
            if c.symbol in sessions and closes_at_close(sessions[c.symbol], session.close)
        )
        complete = after_close and closing >= MIN_COVERAGE

        exposure = shared_exposure(
            [
                (c.symbol, resolved[c.symbol].entity_id, c.isin, c.weight)
                for c in universe.constituents
            ],
            portfolio,
        )
        members = [
            BoardMember(
                symbol=c.symbol,
                name=daily.names.get(c.symbol) or c.name,
                group=c.sector_code,
                weight=c.weight,
                subgroup=resolved[c.symbol].subgroup,
                exposure_gbp=exposure[c.symbol],
                research_ticker=research.get(member_key(market, c.symbol)),
            )
            for c in universe.constituents
        ]
        labels = [
            GroupLabel(key=code, name=SECTOR_NAMES[code])
            for code in sorted({c.sector_code for c in universe.constituents})
        ]
        times = board_times(sessions.values())
        shared = {
            "times": times,
            "daily": daily.closes,
            "daily_sessions": daily_sessions,
            "final_close": session.close if after_close else None,
        }
        groupings = [
            build_grouping(
                "gics",
                labels,
                members,
                sessions,
                subgroup_names={
                    r.subgroup: r.subgroup_name for r in resolved.values() if r.subgroup
                },
                **shared,
            )
        ]
        if themes is not None and themes.labels:
            grouping = build_grouping(
                "themes",
                themes.labels,
                themes.members,
                sessions,
                min_priced=MIN_THEME_MEMBERS,
                **shared,
            )
            if grouping.groups:
                groupings.append(grouping)
        board = SectorBoard(
            market=market,
            session_date=session.date,
            complete=complete,
            as_of=board_as_of(
                (sessions[c.symbol] for c in universe.constituents if c.symbol in sessions),
                fetched_at,
                session.close,
            ),
            fetched_at=fetched_at,
            times=times,
            rank_sessions=[*daily_sessions[1:], session.date],
            member_count=len(universe.constituents),
            priced_count=sum(c.symbol in sessions for c in universe.constituents),
            source=SectorSource(
                universe=universe.universe,
                fund=universe.fund,
                fund_ticker=universe.fund_ticker,
                url=universe.source_url,
                as_of=universe.as_of,
            ),
            exposure_gbp=round(sum(exposure.values()), 2),
            exposure_basis_gbp=portfolio.invested_gbp,
            groupings=[SectorGrouping.model_validate(asdict(grouping)) for grouping in groupings],
        )
        previous = self.boards.load(market)
        if previous is not None and _regresses(previous, board):
            LOGGER.info(
                "sector prices are older than the stored board",
                extra={"market": market, "session": session.date},
            )
            return RefreshResult(published=False, stale=True)
        self._check_active()
        self.boards.save(board)
        problem = (
            f"Closing prices cover {closing:.0%} of the {universe.universe} weight"
            f" for {session.date}"
            if after_close and not complete
            else None
        )
        return RefreshResult(published=True, problem=problem)

    def run_once(self) -> SectorMonitorState:
        """Refresh every market that is due now."""

        now = self._now()
        due = [market for market in MARKETS if self.due(market, now)]
        if not due:
            with self._lock:
                if self._phase in {"starting", "refreshing"}:
                    self._phase = "idle"
            return self.status()
        with self._lock:
            self._phase = "refreshing"
        errors: dict[str, str] = {}
        published = False
        for market in due:
            if not self._active():
                break
            if self._paused_until is not None and self._now() < self._paused_until:
                break
            session = latest_session(market, now)
            backfilling = (
                session is not None
                and self.boards.load(market) is None
                and now > session.close + COMPLETE_AFTER + GIVE_UP_AFTER
            )
            entry: dict[str, Any] = {"lastAttemptAt": self._now().isoformat()}
            result = RefreshResult(published=False)
            try:
                result = self.refresh(market, now)
            except SectorRefreshCancelled:
                break
            except Exception as exc:
                message = _message(exc)
                errors[market] = message
                entry.update(lastError=message, lastErrorAt=self._now().isoformat())
                if isinstance(exc, SparkRateLimited):
                    self._paused_until = self._now() + RATE_LIMIT_PAUSE
                LOGGER.warning(
                    "sector board refresh failed", extra={"market": market, "error": message}
                )
            else:
                if result.problem:
                    errors[market] = result.problem
                    entry.update(lastError=result.problem, lastErrorAt=self._now().isoformat())
                elif not result.stale:
                    entry.update(lastError=None, lastErrorAt=None)
            if result.published:
                published = True
                entry["lastSuccessAt"] = self._now().isoformat()
                self._backfill.pop(market, None)
            elif backfilling and session is not None:
                self._backfill[market] = (
                    session.date,
                    self._backfill_attempts(market, session) + 1,
                )
            with self._lock:
                self._state["markets"].setdefault(market, {}).update(entry)
        with self._lock:
            self._state["lastAttemptAt"] = now.isoformat()
            if published:
                self._state["lastSuccessAt"] = self._now().isoformat()
            self._state["lastError"] = (
                "; ".join(f"{market.upper()}: {message}" for market, message in errors.items())
                or None
            )
            self._phase = "error" if errors else "idle"
            try:
                self._write_state()
            except OSError:
                LOGGER.warning("sector monitor state was not saved", exc_info=True)
        return self.status()

    # Reads -------------------------------------------------------------

    def status(self) -> SectorMonitorState:
        enabled = self.available and self.enabled
        with self._lock:
            state = dict(self._state)
            phase = self._phase
        return SectorMonitorState(
            enabled=enabled,
            phase=phase if enabled else "disabled",
            interval_seconds=self.interval_seconds,
            next_run_at=self.next_run_at(self._now()) if enabled else None,
            last_attempt_at=state.get("lastAttemptAt"),
            last_success_at=state.get("lastSuccessAt"),
            last_error=state.get("lastError"),
        )

    def markets(self, now: datetime) -> list[SectorMarketStatus]:
        statuses = []
        for market, calendar in MARKETS.items():
            board = self.boards.load(market)
            with self._lock:
                entry = dict(self._state["markets"].get(market) or {})
            statuses.append(
                SectorMarketStatus(
                    market=market,
                    calendar=calendar.calendar,
                    timezone=calendar.timezone,
                    sessions=list(
                        sessions_between(
                            market, (now - SESSION_WINDOW).date(), (now + SESSION_WINDOW).date()
                        )
                    ),
                    session_date=board.session_date if board else None,
                    complete=bool(board and board.complete),
                    as_of=board.as_of if board else None,
                    fetched_at=board.fetched_at if board else None,
                    exposure_gbp=board.exposure_gbp if board else 0.0,
                    last_error=entry.get("lastError"),
                    last_error_at=entry.get("lastErrorAt"),
                )
            )
        return statuses

    def response(self, market: SectorMarketCode | None = None) -> SectorBoardResponse:
        now = self._now()
        statuses = self.markets(now)
        chosen = market or default_market(statuses, now)
        return SectorBoardResponse(
            market=chosen,
            markets=statuses,
            board=self.boards.load(chosen),
            monitor=self.status(),
        )

    # Thread ------------------------------------------------------------

    def _tick(self) -> float:
        if not self._active():
            return 3600.0
        now = self._now()
        slot = self._slot(now)
        if slot != self._last_slot:
            self._last_slot = slot
            self.run_once()
            now = self._now()
        remaining = (slot + timedelta(seconds=self.interval_seconds) - now).total_seconds()
        # Short waits keep slots on time after the computer sleeps.
        return min(max(remaining, 1.0), 60.0)

    def _run(self) -> None:
        # Exchange calendars take a moment to build; build them before a page asks.
        try:
            self.markets(self._now())
        except Exception:
            LOGGER.warning("exchange calendars could not be prepared", exc_info=True)
        while not self._stop.is_set():
            try:
                delay = self._tick()
            except Exception:
                LOGGER.exception("sector monitor tick failed")
                delay = 60.0
            self._wake.wait(delay)
            self._wake.clear()

    def configure(self, *, enabled: bool) -> None:
        self.enabled = bool(enabled)
        if self.enabled:
            self._last_slot = None
        self._wake.set()

    def start(self) -> None:
        if not self.available or self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="trading_max-sector-monitor", daemon=True
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


__all__ = [
    "MIN_COVERAGE",
    "SLOT_SECONDS",
    "RefreshResult",
    "SectorBoardStore",
    "SectorMonitor",
    "SectorRefreshCancelled",
    "SectorRefreshError",
    "default_market",
]
