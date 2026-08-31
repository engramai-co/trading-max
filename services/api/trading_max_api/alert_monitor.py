"""Refresh lightweight market data and derive active portfolio alerts."""

from __future__ import annotations

import json
import math
import threading
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import yfinance as yf

from .models import ResearchAlert, SnapshotManifest

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .research import ResearchLedger


JsonObject = dict[str, Any]


class QuoteProvider(Protocol):
    def fetch(self, tickers: Iterable[str]) -> dict[str, float]: ...


class YFinanceQuoteProvider:
    """Fetch the latest traded price in one non-threaded Yahoo request."""

    def fetch(self, tickers: Iterable[str]) -> dict[str, float]:
        symbols = sorted({ticker.strip().upper() for ticker in tickers if ticker})
        if not symbols:
            return {}
        frame = yf.download(
            tickers=" ".join(symbols),
            period="1d",
            interval="5m",
            auto_adjust=False,
            group_by="ticker",
            progress=False,
            repair=False,
            threads=False,
        )
        prices: dict[str, float] = {}
        if frame.empty:
            return prices
        if len(symbols) == 1:
            series = frame.get("Close")
            if series is not None:
                value = series.dropna().iloc[-1] if not series.dropna().empty else None
                if isinstance(value, (int, float)) and math.isfinite(float(value)):
                    prices[symbols[0]] = float(value)
            return prices
        for ticker in symbols:
            try:
                series = frame[ticker]["Close"].dropna()
            except (KeyError, TypeError):
                continue
            if not series.empty and math.isfinite(float(series.iloc[-1])):
                prices[ticker] = float(series.iloc[-1])
        return prices


class LiveAlertStore:
    """Small persistent cache shared by the monitor and request handlers."""

    def __init__(self, data_root: Path) -> None:
        self.path = data_root / "state" / "alert-monitor.json"
        self._lock = threading.RLock()

    def load(self) -> JsonObject:
        with self._lock:
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, ValueError):
                return {"schemaVersion": 1, "quotes": {}, "alerts": {}}
            return payload if isinstance(payload, dict) else {}

    def revision(self) -> str:
        """Return a cheap cache key without decoding the alert payload."""

        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return "missing"
        return f"{stat.st_ino}:{stat.st_mtime_ns}:{stat.st_size}"

    def save(self, payload: JsonObject) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            temporary.replace(self.path)

    def quote(
        self,
        ticker: str,
        *,
        snapshot_run_id: str,
    ) -> tuple[float, str] | None:
        payload = self.load()
        if payload.get("snapshotRunId") != snapshot_run_id:
            return None
        row = payload.get("quotes", {}).get(ticker.upper())
        if not isinstance(row, dict):
            return None
        price = row.get("price")
        as_of = row.get("asOf")
        if not isinstance(price, (int, float)) or not isinstance(as_of, str):
            return None
        return float(price), as_of


class AlertMonitor:
    """Refreshes prices and alert state without running the research pipeline."""

    def __init__(
        self,
        store: ArtifactStore,
        research: ResearchLedger,
        live_store: LiveAlertStore,
        *,
        enabled: bool,
        held_interval_seconds: int = 300,
        watchlist_interval_seconds: int = 900,
        quote_provider: QuoteProvider | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.research = research
        self.live_store = live_store
        self.enabled = enabled
        self.held_interval_seconds = held_interval_seconds
        self.watchlist_interval_seconds = watchlist_interval_seconds
        self.quote_provider = quote_provider or YFinanceQuoteProvider()
        self._now = now or (lambda: datetime.now(UTC))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    @staticmethod
    def _monitoring_window(now: datetime) -> bool:
        utc = now.astimezone(UTC)
        return utc.weekday() < 5 and time(12, 30) <= utc.time() <= time(22, 30)

    @staticmethod
    def _elapsed(value: Any, now: datetime) -> float:
        if not isinstance(value, str):
            return math.inf
        try:
            observed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return math.inf
        return max((now - observed.astimezone(UTC)).total_seconds(), 0.0)

    def _due_tickers(
        self,
        manifest: SnapshotManifest,
        state: JsonObject,
        now: datetime,
    ) -> list[str]:
        instruments = self.research.instruments(manifest)
        held_due = self._elapsed(state.get("heldUpdatedAt"), now) >= (self.held_interval_seconds)
        watchlist_due = self._elapsed(state.get("watchlistUpdatedAt"), now) >= (
            self.watchlist_interval_seconds
        )
        return sorted(
            {item.ticker for item in instruments if watchlist_due or (held_due and item.held)}
        )

    def _serialize_alerts(
        self,
        alerts: list[ResearchAlert],
        previous: JsonObject,
        now_iso: str,
    ) -> dict[str, JsonObject]:
        active: dict[str, JsonObject] = {}
        for alert in alerts:
            old = previous.get(alert.alert_id)
            first_seen = (
                old.get("firstSeenAt")
                if isinstance(old, dict) and old.get("firstSeenAt")
                else now_iso
            )
            active[alert.alert_id] = {
                **alert.model_dump(mode="json", by_alias=True),
                "firstSeenAt": first_seen,
                "lastSeenAt": now_iso,
            }
        return active

    def run_once(self, *, force: bool = False) -> JsonObject:
        now = self._now().astimezone(UTC)
        state = self.live_store.load()
        state.update(
            {
                "schemaVersion": 1,
                "enabled": self.enabled,
                "heldIntervalSeconds": self.held_interval_seconds,
                "watchlistIntervalSeconds": self.watchlist_interval_seconds,
                "lastAttemptAt": now.isoformat(),
            }
        )
        if not force and not self._monitoring_window(now):
            state["phase"] = "paused"
            state["lastError"] = None
            self.live_store.save(state)
            return state

        manifest = self.store.latest_manifest()
        if manifest is None:
            state.update({"phase": "waiting-for-snapshot", "lastError": None})
            self.live_store.save(state)
            return state

        tickers = self._due_tickers(manifest, state, now)
        if not tickers and state.get("snapshotRunId") == manifest.run_id:
            state.update({"phase": "idle", "lastError": None})
            self.live_store.save(state)
            return state

        try:
            instruments = self.research.instruments(manifest)
            held = {item.ticker for item in instruments if item.held}
            if state.get("snapshotRunId") != manifest.run_id:
                tickers = sorted({item.ticker for item in instruments})
                state["quotes"] = {}
                state["alerts"] = {}
            prices = self.quote_provider.fetch(tickers)
            now_iso = now.isoformat()
            quotes = state.setdefault("quotes", {})
            for ticker, price in prices.items():
                quotes[ticker] = {"price": price, "asOf": now_iso}
            if any(ticker in held for ticker in tickers):
                state["heldUpdatedAt"] = now_iso
            if any(ticker not in held for ticker in tickers) or set(tickers) == {
                item.ticker for item in instruments
            }:
                state["watchlistUpdatedAt"] = now_iso
            state["snapshotRunId"] = manifest.run_id
            self.live_store.save(state)

            previous_alerts = state.get("alerts", {})
            all_alerts: list[ResearchAlert] = []
            for item in instruments:
                all_alerts.extend(self.research.alerts(item.ticker, manifest))
            state["alerts"] = self._serialize_alerts(
                all_alerts,
                previous_alerts if isinstance(previous_alerts, dict) else {},
                now_iso,
            )
            state.update(
                {
                    "phase": "idle",
                    "lastSuccessAt": now_iso,
                    "lastError": None,
                    "quoteCount": len(quotes),
                    "activeAlertCount": len(state["alerts"]),
                }
            )
        except Exception as exc:
            state.update(
                {
                    "phase": "error",
                    "lastError": f"{type(exc).__name__}: {exc}",
                }
            )
        self.live_store.save(state)
        return state

    def status(self) -> JsonObject:
        state = self.live_store.load()
        state.setdefault("enabled", self.enabled)
        state.setdefault("heldIntervalSeconds", self.held_interval_seconds)
        state.setdefault(
            "watchlistIntervalSeconds",
            self.watchlist_interval_seconds,
        )
        state.setdefault("phase", "disabled" if not self.enabled else "starting")
        return state

    def _run(self) -> None:
        while not self._stop.is_set():
            self.run_once()
            self._wake.wait(30.0)
            self._wake.clear()

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="trading_max-alert-monitor",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
