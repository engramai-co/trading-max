"""Relocate immutable records while preserving the existing pack format.

Callers hold the repository writer lock and compute roots from every published
manifest. New bytes are durable before a locator transaction, and old bytes
survive until that transaction and its readback have succeeded.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

from .durable_files import atomic_bytes, sync_directory
from .object_packs import ObjectPacks, decode, encode, stamp


def adopt(pool: ObjectPacks, source: Path, keys: set[str]) -> dict:
    """Alias an independently stored recovery pack, never a live state file."""
    before = stamp(source)
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    entries, raw = decode(content)
    if source.name != digest or stamp(source) != before or not keys <= entries.keys():
        raise ValueError("shared recovery pack identity changed")
    selected = {key: entries[key] for key in keys}
    old_keys = [key for key in sorted(keys) if pool.contains(key)]
    for key, original in zip(old_keys, pool.read_many(old_keys), strict=True):
        offset, size, _ = entries[key]
        if original != raw[offset : offset + size]:
            raise ValueError("shared recovery record conflicts with existing bytes")
    pool.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = pool.path(digest)
    if target.exists():
        if target.read_bytes() != content:
            raise ValueError("existing shared recovery pack is corrupt")
    else:
        # Both names live inside the independent backup repository. A link to
        # live application state is deliberately never accepted by the caller.
        os.link(source, target)
        sync_directory(target.parent)
    if stamp(source)[:4] != before[:4] or target.read_bytes() != content:
        raise ValueError("recovery pack changed during alias publication")
    with closing(sqlite3.connect(pool.index, timeout=30)) as db:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT OR IGNORE INTO packs VALUES (?)", (digest,))
        for key, entry in selected.items():
            old = db.execute("SELECT size,digest FROM records WHERE key=?", (key,)).fetchone()
            if old is not None and old != entry[1:]:
                raise ValueError("recovery locator changed during sharing")
            db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)", (key, digest, *entry))
        db.commit()
    sync_directory(pool.root)
    for key, value in zip(sorted(keys), pool.read_many(sorted(keys)), strict=True):
        offset, size, _ = entries[key]
        if value != raw[offset : offset + size]:
            raise ValueError("shared recovery readback failed")
    return {"records": len(keys), "fileBytes": len(content)}


def _receipt(path: Path, value: dict) -> None:
    atomic_bytes(path, json.dumps(value, sort_keys=True).encode())


def _finish_receipt(path: Path, value: dict) -> None:
    value["status"] = "complete"
    encoded = gzip.compress(json.dumps(value, sort_keys=True).encode(), mtime=0)
    atomic_bytes(path.with_suffix(".json.gz"), encoded)
    path.unlink()
    sync_directory(path.parent)


def _retire(pool: ObjectPacks, old: str, before: tuple, replacement: str | None) -> None:
    if replacement:
        pool._load(replacement)
    reader = pool._reader()
    if reader.execute("SELECT 1 FROM records WHERE pack=? LIMIT 1", (old,)).fetchone():
        raise ValueError("old recovery pack is still referenced")
    path = pool.path(old)
    if stamp(path) != before:
        raise ValueError("old recovery pack changed before retirement")
    path.unlink()
    sync_directory(path.parent)


def compact(pool: ObjectPacks, live: set[str], journals: Path, *, window=None) -> dict:
    """Repack unshared containers; a crash leaves old or verified new bytes."""
    if journals.is_symlink():
        raise ValueError("pack rewrite journal must not be a symlink")
    journals.mkdir(parents=True, exist_ok=True, mode=0o700)
    pool.recover_pending()
    reader = pool._reader()
    if reader is None:
        if live:
            raise ValueError("recovery pack roots are missing")
        return {"rewrittenPacks": 0, "retiredFileBytes": 0, "writtenFileBytes": 0}
    present = set(pool.keys())
    if not live <= present:
        raise ValueError("recovery pack root is absent from its index")
    result = {"rewrittenPacks": 0, "retiredFileBytes": 0, "writtenFileBytes": 0}
    packs = [row[0] for row in reader.execute("SELECT digest FROM packs ORDER BY digest")]
    for old in packs:
        if window and window.stopped():
            break
        path = pool.path(old)
        if path.stat().st_nlink > 1:
            continue  # The original pack bytes also back a physical recovery file.
        rows = {
            row[0]: tuple(row[1:])
            for row in reader.execute(
                "SELECT key,offset,size,digest FROM records WHERE pack=?", (old,)
            )
        }
        keep = set(rows) & live
        before = stamp(path)
        entries, raw = pool._load(old)
        if keep == set(entries):
            continue
        if any(entries.get(key) != location for key, location in rows.items()):
            raise ValueError("recovery locator disagrees with original pack")
        replacement = None
        new_entries = {}
        new_bytes = 0
        if keep:
            records = {
                key: raw[entries[key][0] : entries[key][0] + entries[key][1]] for key in keep
            }
            content = encode(records)
            new_entries, decoded = decode(content)
            if any(decoded[o : o + n] != records[key] for key, (o, n, _) in new_entries.items()):
                raise ValueError("rewritten recovery pack readback failed")
            replacement = hashlib.sha256(content).hexdigest()
            target = pool.path(replacement)
            if target.exists():
                if target.read_bytes() != content:
                    raise ValueError("rewritten recovery target is corrupt")
            else:
                atomic_bytes(target, content)
                new_bytes = len(content)
        journal = {
            "schemaVersion": 1,
            "pool": str(pool.root),
            "old": old,
            "replacement": replacement,
            "status": "prepared",
            "keptRecords": len(keep),
        }
        receipt = journals / (uuid.uuid4().hex + ".json")
        _receipt(receipt, journal)
        if stamp(path) != before:
            raise ValueError("original recovery pack changed before locator commit")
        with closing(sqlite3.connect(pool.index, timeout=30)) as db:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE")
            current = {
                row[0]: tuple(row[1:])
                for row in db.execute(
                    "SELECT key,offset,size,digest FROM records WHERE pack=?", (old,)
                )
            }
            if current != rows:
                raise ValueError("recovery locators changed during compaction")
            if replacement:
                db.execute("INSERT OR IGNORE INTO packs VALUES (?)", (replacement,))
                for key, entry in new_entries.items():
                    db.execute(
                        "UPDATE records SET pack=?,offset=?,size=?,digest=? WHERE key=?",
                        (replacement, *entry, key),
                    )
            db.execute("DELETE FROM records WHERE pack=?", (old,))
            db.execute("DELETE FROM packs WHERE digest=?", (old,))
            db.commit()
        sync_directory(pool.root)
        _retire(pool, old, before, replacement)
        _finish_receipt(receipt, journal)
        result["rewrittenPacks"] += 1
        result["retiredFileBytes"] += before[2]
        result["writtenFileBytes"] += new_bytes
        if window:
            window.report(**result)
    # Reconcile receipts from a crash after index commit or unlink. Their source
    # was either retried above or still exists; never retire bytes from a receipt.
    for path in journals.glob("*.json"):
        if path.is_symlink():
            raise ValueError("rewrite receipt must not be a symlink")
        receipt = json.loads(path.read_bytes())
        if receipt.get("schemaVersion") != 1 or receipt.get("pool") != str(pool.root):
            raise ValueError("invalid rewrite receipt")
        if not pool.path(receipt["old"]).exists():
            _finish_receipt(path, receipt)
    return result
