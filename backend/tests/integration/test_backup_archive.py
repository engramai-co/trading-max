from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from tools.verify_backup_archive import verify_archive


def _archive(path: Path, names: list[str]) -> None:
    with tarfile.open(path, mode="w:gz") as handle:
        for name in names:
            source = path.parent / name.replace("/", "_")
            source.write_text("fixture", encoding="utf-8")
            handle.add(source, arcname=name)
            source.unlink()


def test_backup_archive_rejects_secrets_and_traversal(tmp_path: Path) -> None:
    unsafe = tmp_path / "unsafe.tar.gz"
    _archive(unsafe, ["state/watchlist.json", "state/secrets/key"])

    with pytest.raises(ValueError, match="secret-bearing"):
        verify_archive(unsafe)

    traversal = tmp_path / "traversal.tar.gz"
    _archive(traversal, ["state/watchlist.json", "../outside"])

    with pytest.raises(ValueError, match="unsafe archive"):
        verify_archive(traversal)


def test_backup_archive_accepts_external_state_without_credentials(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "safe.tar.gz"
    _archive(archive, ["state/trading_max.db", "state/watchlist.json"])

    assert verify_archive(archive) == ["state/trading_max.db", "state/watchlist.json"]


def test_backup_archive_rejects_links_and_duplicate_paths(tmp_path: Path) -> None:
    link_archive = tmp_path / "link.tar.gz"
    source = tmp_path / "source"
    source.write_text("fixture", encoding="utf-8")
    with tarfile.open(link_archive, mode="w:gz") as handle:
        handle.add(source, arcname="state/source")
        link = tarfile.TarInfo("state/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "source"
        handle.addfile(link)

    with pytest.raises(ValueError, match="unsafe archive member type"):
        verify_archive(link_archive)

    duplicate_archive = tmp_path / "duplicate.tar.gz"
    with tarfile.open(duplicate_archive, mode="w:gz") as handle:
        for _ in range(2):
            item = tarfile.TarInfo("state/watchlist.json")
            item.size = len(b"fixture")
            handle.addfile(item, io.BytesIO(b"fixture"))

    with pytest.raises(ValueError, match="duplicate paths"):
        verify_archive(duplicate_archive)
