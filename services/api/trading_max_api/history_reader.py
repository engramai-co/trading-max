"""Rebuildable, bounded history index; immutable snapshot artifacts remain authoritative."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import zlib
from contextlib import closing, suppress
from datetime import UTC, datetime

from pydantic import ValidationError

from .artifacts import ArtifactStore
from .dashboard_models import NavPoint
from .history_projection import (
    HistoryRange,
    HistoryScope,
    portfolio_day,
    project_intraday,
    scope_points,
    window_start,
)
from .models import ApiModel, SnapshotManifest
from .projections.broker import overlay_live_broker_snapshot
from .projections.nav import intraday_nav_points, nav_series

_KEYS = (
    "account/nav/daily_nav_a.csv",
    "account/nav/daily_nav_b.csv",
    "account/nav/daily_nav_c.csv",
    "account/nav/valuation_history.json",
    "account/nav/intraday_anchors.json",
    "account/nav/cash_flows_a.json",
    "account/nav/cash_flows_b.json",
)
_APPLICATION_ID = 0x544D4801


class CorruptHistoryCache(ValueError):
    """A derived row no longer matches the content that produced its identity."""


class HistorySnapshot(ApiModel):
    run_id: str
    broker_as_of: str
    data_revision: str
    nav: list[NavPoint]
    intraday_nav: list[NavPoint]


def load_history(
    store: ArtifactStore, manifest: SnapshotManifest
) -> tuple[list[NavPoint], list[NavPoint]]:
    """Use the existing accounting projection without opening research or review artifacts."""
    run = manifest.run_id
    c_text = None
    with suppress(FileNotFoundError):
        c_text = store.read_text(run, _KEYS[2])
    daily = nav_series(store.read_text(run, _KEYS[0]), store.read_text(run, _KEYS[1]), c_text)
    raw = None
    for key in _KEYS[3:5]:
        try:
            raw = store.read_json(run, key)
            break
        except (FileNotFoundError, TypeError, ValueError):
            pass
    flows = {}
    for profile, key in zip(("invest", "isa"), _KEYS[5:], strict=True):
        with suppress(FileNotFoundError, TypeError, ValueError):
            flows[profile] = store.read_json(run, key)
    return (
        [NavPoint.model_validate(p) for p in daily],
        [NavPoint.model_validate(p) for p in intraday_nav_points(raw, flows)],
    )


class HistoryReader:
    """Deduplicate unchanged observations across two cached dataset revisions.

    Only this derived namespace may be reset. Reads and rebuilds share a lock,
    SQLite publishes a dataset atomically, and an oversized dataset is served
    from the original projection without retaining an oversized cache.
    """

    def __init__(self, store: ArtifactStore, *, byte_limit: int = 64 * 1024 * 1024):
        self.store = store
        self.path = store.data_root / "runtime/history-query-cache-v1/index.sqlite3"
        self.byte_limit = byte_limit
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink() or self.path.parent.is_symlink():
            raise ValueError("history cache must not be a symlink")
        fresh = not self.path.exists()
        con = sqlite3.connect(self.path, timeout=20)
        try:
            if fresh:
                con.execute("PRAGMA auto_vacuum=FULL")
                con.execute(f"PRAGMA application_id={_APPLICATION_ID}")
            if con.execute("PRAGMA application_id").fetchone()[0] != _APPLICATION_ID:
                raise ValueError("unrecognized history cache; original file preserved")
            con.executescript("""
                CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, touched REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY, payload BLOB NOT NULL, day TEXT NOT NULL,
                    stamp REAL NOT NULL, observed INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS members (
                    dataset TEXT NOT NULL, kind INTEGER NOT NULL, position INTEGER NOT NULL,
                    observation TEXT NOT NULL, PRIMARY KEY(dataset, kind, position));
                CREATE INDEX IF NOT EXISTS member_observation ON members(observation);
                CREATE INDEX IF NOT EXISTS observation_day ON observations(day);
            """)
            self.path.chmod(0o600)
            return con
        except BaseException:
            con.close()
            raise

    @staticmethod
    def _decode(payload: bytes, digest: str) -> NavPoint:
        raw = zlib.decompress(payload)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise CorruptHistoryCache("history cache row checksum differs")
        return NavPoint.model_validate_json(raw)

    def _populate(
        self,
        con: sqlite3.Connection,
        revision: str,
        daily: list[NavPoint],
        intraday: list[NavPoint],
    ) -> None:
        with con:
            for kind, points in enumerate((daily, intraday)):
                rows = []
                members = []
                for position, point in enumerate(points):
                    payload = point.model_dump_json().encode()
                    digest = hashlib.sha256(payload).hexdigest()
                    parsed = datetime.fromisoformat(point.date.replace("Z", "+00:00"))
                    stamp = (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).timestamp()
                    rows.append(
                        (
                            digest,
                            zlib.compress(payload),
                            portfolio_day(point.date).isoformat(),
                            stamp,
                            point.valuation_source != "reconstructed",
                        )
                    )
                    members.append((revision, kind, position, digest))
                con.executemany("INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?, ?)", rows)
                con.executemany("INSERT INTO members VALUES (?, ?, ?, ?)", members)
            con.execute(
                "INSERT INTO datasets VALUES (?, ?)", (revision, datetime.now(UTC).timestamp())
            )
            con.execute(
                "DELETE FROM datasets WHERE id NOT IN (SELECT id FROM datasets ORDER BY touched DESC LIMIT 2)"
            )
            con.execute("DELETE FROM members WHERE dataset NOT IN (SELECT id FROM datasets)")
            con.execute(
                "DELETE FROM observations WHERE id NOT IN (SELECT observation FROM members)"
            )

    def _query(
        self,
        con: sqlite3.Connection,
        revision: str,
        as_of: str,
        range_name: HistoryRange,
        scope: HistoryScope,
    ) -> tuple[list[NavPoint], list[NavPoint]]:
        joined = "FROM members m JOIN observations o ON o.id=m.observation WHERE m.dataset=? AND m.kind=?"
        daily = [
            self._decode(p[0], p[1])
            for p in con.execute(
                "SELECT o.payload,o.id " + joined + " ORDER BY m.position", (revision, 0)
            )
        ]
        if scope == "cfd":
            return daily, []
            # Intraday projection admits only rows with all A/B/total values. Preserve
            # the first record, first broker boundary and last record before windowing.
        anchors = []
        for clause in (
            "ORDER BY o.stamp LIMIT 1",
            "AND o.observed=1 ORDER BY o.stamp LIMIT 1",
            "ORDER BY o.stamp DESC LIMIT 1",
        ):
            row = con.execute(
                "SELECT o.id,o.day " + joined + " " + clause, (revision, 1)
            ).fetchone()
            if row:
                anchors.append(row)
        effective = "total" if scope == "household" else scope
        references = [portfolio_day(as_of)] + [
            portfolio_day(p.date) for p in daily if getattr(p, effective) is not None
        ]
        references += [portfolio_day(row[1]) for row in anchors]
        start = window_start(max(references), range_name)
        params: list = [revision, 1]
        where = ""
        if start is not None:
            where = " AND (o.day>=? OR o.id IN (?, ?, ?))"
            params.extend([start.isoformat(), *([a[0] for a in anchors] + [""] * 3)[:3]])
        rows = con.execute(
            "SELECT o.payload,o.id " + joined + where + " ORDER BY m.position", params
        )
        return daily, [self._decode(row[0], row[1]) for row in rows]

    def read(
        self, manifest: SnapshotManifest, range_name: HistoryRange, scope: HistoryScope
    ) -> HistorySnapshot:
        references = sorted((a.key, a.sha256) for a in manifest.artifacts if a.key in _KEYS)
        revision = hashlib.sha256(json.dumps([1, references]).encode()).hexdigest()
        broker = self.store.read_json(manifest.run_id, "account/broker_snapshot_metrics.json")
        live = None
        with suppress(FileNotFoundError, TypeError, ValueError):
            live = self.store.read_json(manifest.run_id, "account/intraday/broker_values.json")
        as_of = str(
            overlay_live_broker_snapshot(broker, live).get("generated_at_utc")
            or manifest.created_at.isoformat()
        )
        try:
            with self._lock, closing(self._connect()) as con:
                if not con.execute("SELECT 1 FROM datasets WHERE id=?", (revision,)).fetchone():
                    daily, intraday = load_history(self.store, manifest)
                    self._populate(con, revision, daily, intraday)
                with con:
                    con.execute(
                        "UPDATE datasets SET touched=? WHERE id=?",
                        (datetime.now(UTC).timestamp(), revision),
                    )
                daily, intraday = self._query(con, revision, as_of, range_name, scope)
                if self.path.stat().st_size > self.byte_limit:
                    # This is an expendable index only; originals remain in immutable
                    # storage. FULL auto-vacuum returns its freed pages immediately.
                    with con:
                        con.execute("DELETE FROM members")
                        con.execute("DELETE FROM observations")
                        con.execute("DELETE FROM datasets")
        except (sqlite3.DatabaseError, zlib.error, ValidationError, CorruptHistoryCache):
            # A derived-cache failure cannot change a balance or make original
            # records unavailable. Preserve the damaged file for diagnosis.
            logging.getLogger(__name__).warning(
                "History query index unavailable; reading immutable source"
            )
            daily, intraday = load_history(self.store, manifest)
            intraday = project_intraday(
                intraday, daily, as_of=as_of, range_name=range_name, scope=scope
            )
        return HistorySnapshot(
            run_id=manifest.run_id,
            broker_as_of=as_of,
            data_revision=revision,
            nav=scope_points(daily, scope),
            intraday_nav=scope_points(intraday, scope),
        )
