"""Read-only Alpaca market data and the budget shared by API and worker."""

from __future__ import annotations

import fcntl
import json
import math
import os
import time
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

DATA_URL = "https://data.alpaca.markets"
REQUEST_LIMIT = 180
WORKER_LIMIT = 165
WINDOW_SECONDS = 60
DEFAULT_BACKOFF_SECONDS = 60


class AlpacaDataError(RuntimeError):
    """A deliberately non-secret provider error."""


class AlpacaRateBudget:
    """A rolling minute shared by all clients in one workspace, with room for quotes."""

    def __init__(self, path: Path, *, clock=time.time, sleep=time.sleep) -> None:
        self._path, self._clock, self._sleep = path, clock, sleep

    @contextmanager
    def _locked(self, *, wait: bool):
        # Lock a separate inode: the state is atomically replaced and contains
        # only request times, never keys, ticker symbols, or request contents.
        self._path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        fd = os.open(self._path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            try:
                timestamps, paused = json.loads(self._path.read_bytes())
            except FileNotFoundError:
                timestamps, paused = [], 0
            if not isinstance(timestamps, list) or not all(
                isinstance(t, int | float) and math.isfinite(t) for t in [*timestamps, paused]
            ):
                raise ValueError("invalid Alpaca budget state")
            now = self._clock()
            yield now, sorted(t for t in timestamps if t > now - WINDOW_SECONDS), paused

    def _write(self, timestamps: list[float], paused: float) -> None:
        temporary = self._path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump([timestamps, paused], stream, separators=(",", ":"))
        temporary.replace(self._path)

    def reserve(self, *, wait_seconds: float) -> None:
        limit = WORKER_LIMIT if wait_seconds else REQUEST_LIMIT
        deadline = self._clock() + wait_seconds
        while True:
            try:
                with self._locked(wait=False) as (now, stamps, paused):
                    ready = max(
                        paused,
                        stamps[len(stamps) - limit] + WINDOW_SECONDS if len(stamps) >= limit else 0,
                    )
                    if now >= ready:
                        self._write([*stamps, now], paused)
                        return
                    delay = max(ready - now, 0.01)
            except BlockingIOError:
                now, delay = self._clock(), 0.02
            except (OSError, ValueError, TypeError):
                raise AlpacaDataError("Alpaca request budget unavailable") from None
            if not wait_seconds or now + delay > deadline:
                raise AlpacaDataError("Alpaca request budget exhausted or paused")
            self._sleep(delay)

    def pause(self, retry_after: str | None) -> None:
        try:
            with self._locked(wait=True) as (now, stamps, paused):
                self._write(stamps, max(paused, now + _retry_delay(retry_after, now)))
        except (OSError, ValueError, TypeError):
            raise AlpacaDataError("Alpaca request budget unavailable") from None


def _retry_delay(value: str | None, now: float) -> float:
    if value:
        try:
            delay = float(value)
        except ValueError:
            try:
                delay = parsedate_to_datetime(value).timestamp() - now
            except (ValueError, TypeError, OverflowError):
                delay = DEFAULT_BACKOFF_SECONDS
        if math.isfinite(delay) and delay > 0:
            return delay
    return DEFAULT_BACKOFF_SECONDS


class AlpacaHTTP:
    def __init__(
        self, key: str, secret: str, *, budget: AlpacaRateBudget, transport=None, sleep=time.sleep
    ) -> None:
        self._headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self._budget, self._transport, self._sleep = budget, transport, sleep

    def client(self, *, timeout: float) -> httpx.Client:
        return httpx.Client(
            base_url=DATA_URL,
            headers=self._headers,
            timeout=timeout,
            follow_redirects=False,
            transport=self._transport,
        )

    def get(
        self, client: httpx.Client, path: str, params: dict[str, str | int], *, wait: float = 0
    ) -> dict:
        for attempt in range(3 if wait else 1):
            self._budget.reserve(wait_seconds=wait)
            try:
                response = client.get(path, params=params)
            except httpx.HTTPError:
                raise AlpacaDataError("Alpaca market data unavailable") from None
            status = response.status_code
            if status == 429:
                self._budget.pause(response.headers.get("Retry-After"))
            if status == 200:
                try:
                    payload = response.json()
                except ValueError:
                    raise AlpacaDataError("Alpaca returned invalid market data") from None
                if not isinstance(payload, dict):
                    raise AlpacaDataError("Alpaca returned invalid market data")
                return payload
            if wait and attempt < 2 and (status == 429 or status >= 500):
                if status >= 500:
                    self._sleep(2**attempt)
                continue
            raise AlpacaDataError(f"Alpaca market data HTTP {status}")
        raise AssertionError("unreachable")
