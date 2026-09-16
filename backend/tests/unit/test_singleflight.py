from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from trading_max.infrastructure.singleflight import SingleFlightCache


def test_slow_miss_does_not_block_a_different_cached_key():
    cache = SingleFlightCache(2)
    cache.get_or_compute("hot", lambda: 7)
    started, release = Event(), Event()

    def slow():
        started.set()
        if not release.wait(5):
            raise TimeoutError("test did not release cold request")
        return 42

    with ThreadPoolExecutor(3) as pool:
        cold = pool.submit(cache.resolve, "cold", slow)
        assert started.wait(2)
        try:
            hot = pool.submit(cache.resolve, "hot", lambda: pytest.fail("hot reloaded"))
            assert hot.result(timeout=1).value == 7
            duplicate = pool.submit(cache.resolve, "cold", lambda: pytest.fail("duplicate load"))
        finally:
            release.set()
        assert cold.result().value == duplicate.result().value == 42


def test_failures_are_retryable_and_lru_eviction_is_incremental():
    cache = SingleFlightCache(2)
    with pytest.raises(ValueError, match="provider failed"):
        cache.get_or_compute("a", lambda: (_ for _ in ()).throw(ValueError("provider failed")))
    assert cache.get_or_compute("a", lambda: 1) == 1
    cache.get_or_compute("b", lambda: 2)
    assert cache.resolve("a", lambda: 0).status == "hit"
    cache.get_or_compute("c", lambda: 3)
    assert cache.resolve("a", lambda: 0).status == "hit"
    assert cache.resolve("b", lambda: 4).value == 4


def test_freshness_uses_source_value_not_when_it_entered_memory():
    cache = SingleFlightCache(2)
    assert cache.get_or_compute("price", lambda: 10, valid=lambda n: n > 20) == 10
    assert cache.get_or_compute("price", lambda: 30, valid=lambda n: n > 20) == 30
    assert cache.resolve("price", lambda: 0, valid=lambda n: n > 20).status == "hit"
