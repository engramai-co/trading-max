from collections import Counter

import pytest
from trading_max.infrastructure.history_chunks import FORMAT as HISTORY_FORMAT
from trading_max.infrastructure.history_chunks import HistoryChunks
from trading_max.infrastructure.json_chunks import FORMAT as JSON_FORMAT
from trading_max.infrastructure.json_chunks import JsonChunks
from trading_max.infrastructure.verified_chunks import ChunkPathCache


def test_shared_history_paths_are_checked_once_per_scan_and_fresh_on_the_next(
    tmp_path, monkeypatch
):
    history = HistoryChunks(tmp_path / "artifacts")
    digest = "a" * 64
    descriptor = {
        "$format": HISTORY_FORMAT,
        "chunks": [{"values": {"sha256": digest}, "sources": {"sha256": digest}}] * 500,
    }
    checked = Counter()
    original = history.path

    def inspect(value):
        checked[value] += 1
        return original(value)

    monkeypatch.setattr(history, "path", inspect)
    cache = ChunkPathCache()
    for _ in range(20):
        paths = history.paths(descriptor, path_cache=cache)
        assert len(paths) == 1
    assert checked[digest] == 1
    paths[0].parent.mkdir(parents=True)
    paths[0].symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        history.paths(descriptor, path_cache=ChunkPathCache())
    with pytest.raises(ValueError, match="symlink"):
        history.paths(descriptor)  # Interactive/default readers are never cached.


def test_cache_is_bounded_and_does_not_mix_chunk_roots(tmp_path, monkeypatch):
    stores = [JsonChunks(tmp_path / "one"), JsonChunks(tmp_path / "two")]
    cache = ChunkPathCache(max_entries=2)
    checked = Counter()
    for store in stores:
        original = store.path

        def inspect(digest, source=original):
            path = source(digest)
            checked[path] += 1
            return path

        monkeypatch.setattr(store, "path", inspect)
    descriptor = {"$format": JSON_FORMAT, "envelopeBytes": 2, "tree": ["blob", "a" * 64, 2]}
    first = stores[0].paths(descriptor, path_cache=cache)[0]
    second = stores[1].paths(descriptor, path_cache=cache)[0]
    assert first != second and checked[first] == checked[second] == 1
    stores[0].paths({**descriptor, "tree": ["blob", "b" * 64, 2]}, path_cache=cache)
    stores[0].paths(descriptor, path_cache=cache)
    assert len(cache.entries) == 2 and checked[first] == 2
    with pytest.raises(ValueError, match="digest"):
        stores[0].paths({**descriptor, "tree": ["blob", "../invalid", 2]}, path_cache=cache)
    with pytest.raises(ValueError, match="blocks exceed"):
        stores[0].paths({**descriptor, "tree": ["blob", "a" * 64, 500]}, path_cache=cache)
