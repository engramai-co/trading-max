from __future__ import annotations

import errno
import hashlib
import os
import shutil
import stat
from pathlib import Path

import pytest
from trading_max import shared_runtime
from trading_max.shared_runtime import orphan_dependencies, share_dependencies


def dependency(root: Path, name="package/data.bin", data=b"immutable package fixture" * 500):
    path = root / ".venv/lib/python3.12/site-packages" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_releases_share_content_without_mutating_external_cache_and_survive_other_removal(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    original = dependency(first)
    cache = tmp_path / "external-cache"
    os.link(original, cache)
    cache_before = (cache.stat().st_ino, stat.S_IMODE(cache.stat().st_mode))
    other = dependency(second)
    pool = tmp_path / "pool"
    result = share_dependencies(first, pool)
    assert result["linkedFiles"] == 1
    assert original.stat().st_ino != cache.stat().st_ino
    assert (cache.stat().st_ino, stat.S_IMODE(cache.stat().st_mode)) == cache_before
    share_dependencies(second, pool)
    assert original.stat().st_ino == other.stat().st_ino
    assert not original.stat().st_mode & 0o222
    assert share_dependencies(first, pool)["alreadySharedFiles"] == 1
    shutil.rmtree(first)
    shutil.rmtree(pool)
    assert other.read_bytes() == cache.read_bytes()


def test_mode_separation_exclusions_and_full_dependency_roots(tmp_path):
    release, pool = tmp_path / "release", tmp_path / "pool"
    readonly = dependency(release, "package/data.bin")
    executable = dependency(release, "package/engine")
    executable.chmod(0o755)
    excluded = [dependency(release, "__pycache__/compiled.pyc"), dependency(release, "a.pth")]
    excluded.append(dependency(release, "package/small", b"small"))
    dependency(release, "alias").unlink()
    (readonly.parent.parent / "alias").symlink_to(readonly)
    web = release / "apps/web/.next/standalone/node_modules/pkg/index.js"
    web.parent.mkdir(parents=True)
    web.write_bytes(readonly.read_bytes())
    git = release / ".git/objects/pack/data.pack"
    git.parent.mkdir(parents=True)
    git.write_bytes(readonly.read_bytes())
    before = [p.stat().st_ino for p in excluded]
    share_dependencies(release, pool)
    assert readonly.stat().st_ino == web.stat().st_ino == git.stat().st_ino
    assert readonly.stat().st_ino != executable.stat().st_ino
    assert stat.S_IMODE(executable.stat().st_mode) == 0o555
    assert [p.stat().st_ino for p in excluded] == before


def test_cross_filesystem_keeps_independent_source(tmp_path, monkeypatch):
    release, pool = tmp_path / "release", tmp_path / "pool"
    source = dependency(release)
    before = source.stat()

    def unavailable(*args, **kwargs):
        raise OSError(errno.EXDEV, "cross filesystem")

    monkeypatch.setattr(shared_runtime.os, "link", unavailable)
    result = share_dependencies(release, pool)
    assert result["independentFallbackFiles"] == 1
    assert (source.stat().st_ino, source.stat().st_mode) == (before.st_ino, before.st_mode)


def test_changed_source_or_corrupt_pool_is_never_replaced(tmp_path, monkeypatch):
    release, pool = tmp_path / "release", tmp_path / "pool"
    source = dependency(release)
    original_digest = shared_runtime.file_digest
    touched = False

    def change_after_copy(path):
        nonlocal touched
        digest = original_digest(path)
        if path.name.startswith(".pending-") and not touched:
            source.write_bytes(b"new valid owner contents")
            touched = True
        return digest

    monkeypatch.setattr(shared_runtime, "file_digest", change_after_copy)
    with pytest.raises(ValueError, match="source changed"):
        share_dependencies(release, pool)
    assert source.read_bytes() == b"new valid owner contents"
    monkeypatch.setattr(shared_runtime, "file_digest", original_digest)
    source = dependency(release)
    blob = next(p for p in pool.iterdir() if not p.name.startswith("."))
    blob.chmod(0o644)
    blob.write_bytes(b"corruption")
    blob.chmod(0o444)
    before = source.stat().st_ino
    with pytest.raises(ValueError, match="unexpected contents"):
        share_dependencies(release, pool)
    assert source.stat().st_ino == before


def test_pool_symlink_escape_is_rejected_and_only_old_unlinked_content_is_eligible(tmp_path):
    release, pool = tmp_path / "release", tmp_path / "pool"
    source = dependency(release)
    outside = tmp_path / "outside"
    outside.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(outside)
    with pytest.raises(ValueError, match="separate"):
        share_dependencies(release, alias / "nested")
    share_dependencies(release, pool)
    blob = next(p for p in pool.iterdir() if not p.name.startswith("."))
    os.utime(blob, (0, 0))
    assert orphan_dependencies(pool, 1) == []
    source.unlink()
    assert orphan_dependencies(pool, 1) == [blob]
    unknown = pool / "personal-file"
    unknown.write_bytes(b"keep")
    recent_data = b"recent immutable dependency"
    recent = pool / (hashlib.sha256(recent_data).hexdigest() + "-444")
    recent.write_bytes(recent_data)
    recent.chmod(0o444)
    assert orphan_dependencies(pool, 1) == [blob]
    blob.chmod(0o644)
    with pytest.raises(ValueError, match="corrupt or writable"):
        orphan_dependencies(pool, 1)
