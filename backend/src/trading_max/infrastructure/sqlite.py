"""Small SQLite infrastructure layer with explicit migrations and WAL mode."""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class SqliteDatabase:
    """One process-local SQLite connection configured for durable state."""

    def __init__(self, path: Path, migrations_dir: Path | None = None) -> None:
        self.path = path.expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrations_dir = migrations_dir or (Path(__file__).resolve().parents[3] / "migrations")
        self._lock = threading.RLock()
        self.connection = sqlite3.connect(
            self.path,
            check_same_thread=False,
            isolation_level=None,
        )
        self.connection.row_factory = sqlite3.Row
        # journal_mode=WAL changes database metadata and can raise immediately
        # when the API and worker start at the same time; unlike normal DML it
        # does not consistently honour busy_timeout on all SQLite builds.
        self.connection.execute("PRAGMA busy_timeout=5000")
        for attempt in range(8):
            try:
                self.connection.execute("PRAGMA journal_mode=WAL")
                break
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 7:
                    raise
                time.sleep(min(0.05 * (2**attempt), 1.0))
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield self.connection
            except Exception:
                self.connection.rollback()
                raise
            else:
                self.connection.commit()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """Serialize reads with writes when a test worker shares a connection."""

        with self._lock:
            yield self.connection

    def _migrate(self) -> None:
        with self._lock:
            self.connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            for migration in sorted(self.migrations_dir.glob("*.sql")):
                with self.transaction(immediate=True) as connection:
                    already_applied = connection.execute(
                        "SELECT 1 FROM schema_migrations WHERE version = ?",
                        (migration.name,),
                    ).fetchone()
                    if already_applied is not None:
                        continue
                    # executescript() implicitly commits and would release the
                    # cross-process write lock halfway through a migration.
                    # These migrations are intentionally simple DDL; execute
                    # each statement inside the explicit IMMEDIATE transaction
                    # so API and worker startup cannot apply the same version.
                    statements = (
                        statement.strip()
                        for statement in migration.read_text(encoding="utf-8").split(";")
                    )
                    for statement in statements:
                        if statement:
                            connection.execute(statement)
                    connection.execute(
                        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) "
                        "VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        (migration.name,),
                    )

    def close(self) -> None:
        with self._lock:
            self.connection.close()
