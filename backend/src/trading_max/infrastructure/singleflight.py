"""Bounded process cache that coalesces only identical in-flight work."""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class CacheLookup[V]:
    value: V
    status: Literal["hit", "miss", "coalesced"]


class SingleFlightCache[K: Hashable, V]:
    """Never hold the cache lock while loading or waiting for another key.

    Values are shared, so callers must copy a mutable value before changing it.
    Freshness belongs to the data: ``valid`` can inspect its source timestamp
    instead of silently renewing an old disk entry's lifetime on memory load.
    """

    def __init__(self, capacity: int = 128) -> None:
        if capacity < 1:
            raise ValueError("cache capacity must be positive")
        self.capacity = capacity
        self._lock = threading.Lock()
        self._values: OrderedDict[K, V] = OrderedDict()
        self._pending: dict[K, Future[V]] = {}

    def resolve(
        self,
        key: K,
        load: Callable[[], V],
        *,
        valid: Callable[[V], bool] | None = None,
    ) -> CacheLookup[V]:
        with self._lock:
            if key in self._values:
                value = self._values[key]
                if valid is None or valid(value):
                    self._values.move_to_end(key)
                    return CacheLookup(value, "hit")
                del self._values[key]
            pending = self._pending.get(key)
            owner = pending is None
            if owner:
                pending = Future()
                self._pending[key] = pending
        if not owner:
            return CacheLookup(pending.result(), "coalesced")
        try:
            value = load()
        except BaseException as exc:
            with self._lock:
                self._pending.pop(key, None)
            pending.set_exception(exc)
            raise
        with self._lock:
            self._values[key] = value
            self._values.move_to_end(key)
            while len(self._values) > self.capacity:
                self._values.popitem(last=False)
            self._pending.pop(key, None)
        pending.set_result(value)
        return CacheLookup(value, "miss")

    def get_or_compute(
        self, key: K, load: Callable[[], V], *, valid: Callable[[V], bool] | None = None
    ) -> V:
        return self.resolve(key, load, valid=valid).value
