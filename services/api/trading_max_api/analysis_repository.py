"""Durable SQLite persistence for analysis run metadata and latest pointers."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from trading_max.infrastructure import SqliteDatabase

from .analysis_lenses import normalize_lens, page_for_lens
from .models import AnalysisLens, AnalysisRunRecord

MIGRATIONS = Path(__file__).resolve().parents[3] / "backend" / "migrations"


def _parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class AnalysisRunRepository:
    """Store analysis control-plane state without filesystem mtime indexes."""

    def __init__(self, database: SqliteDatabase) -> None:
        self.database = database

    @staticmethod
    def _from_row(row: Any) -> AnalysisRunRecord:
        persisted_lenses = json.loads(row["lenses_json"])
        if not persisted_lenses:
            persisted_lenses = json.loads(row["pages_json"])
        return AnalysisRunRecord(
            run_id=row["run_id"],
            snapshot_run_id=row["snapshot_run_id"],
            trigger=row["trigger"],
            status=row["status"],
            lenses=[normalize_lens(value) for value in persisted_lenses],
            ticker=row["ticker"],
            provider=row["provider"],
            model=row["model"],
            route=row["route"],
            adapter=row["adapter"],
            provider_revision=row["provider_revision"],
            route_policy_revision=row["route_policy_revision"],
            force=bool(row["force"]),
            created_at=_parse(row["created_at"]),
            started_at=_parse(row["started_at"]),
            finished_at=_parse(row["finished_at"]),
            artifact_ids=json.loads(row["artifact_ids_json"]),
            errors=json.loads(row["errors_json"]),
            cached=bool(row["cached"]),
        )

    def save(self, record: AnalysisRunRecord) -> None:
        payload = record.model_dump(mode="json", by_alias=False)
        legacy_pages = [page_for_lens(lens) for lens in record.lenses]
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO analysis_runs("
                "run_id, snapshot_run_id, trigger, status, pages_json, lenses_json, ticker, "
                "provider, model, route, adapter, provider_revision, route_policy_revision, "
                "force, created_at, started_at, finished_at, "
                "artifact_ids_json, errors_json, cached"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(run_id) DO UPDATE SET "
                "snapshot_run_id=excluded.snapshot_run_id, trigger=excluded.trigger, "
                "status=excluded.status, pages_json=excluded.pages_json, "
                "lenses_json=excluded.lenses_json, ticker=excluded.ticker, "
                "provider=excluded.provider, model=excluded.model, route=excluded.route, "
                "adapter=excluded.adapter, provider_revision=excluded.provider_revision, "
                "route_policy_revision=excluded.route_policy_revision, force=excluded.force, "
                "created_at=excluded.created_at, started_at=excluded.started_at, "
                "finished_at=excluded.finished_at, artifact_ids_json=excluded.artifact_ids_json, "
                "errors_json=excluded.errors_json, cached=excluded.cached",
                (
                    payload["run_id"],
                    payload["snapshot_run_id"],
                    payload["trigger"],
                    payload["status"],
                    json.dumps(legacy_pages),
                    json.dumps(payload["lenses"]),
                    payload["ticker"],
                    payload["provider"],
                    payload["model"],
                    payload["route"],
                    payload["adapter"],
                    payload["provider_revision"],
                    payload["route_policy_revision"],
                    int(payload["force"]),
                    payload["created_at"],
                    payload["started_at"],
                    payload["finished_at"],
                    json.dumps(payload["artifact_ids"]),
                    json.dumps(payload["errors"]),
                    int(payload["cached"]),
                ),
            )

    def get(self, run_id: str) -> AnalysisRunRecord:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM analysis_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"analysis run not found: {run_id}")
        return self._from_row(row)

    def list(self, limit: int = 20) -> list[AnalysisRunRecord]:
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT * FROM analysis_runs ORDER BY created_at DESC LIMIT ?",
                (max(1, min(limit, 100)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def recover_interrupted(self, *, message: str) -> int:
        """Mark claimed/running runs interrupted; leave queued work resumable."""

        now = datetime.now(UTC).isoformat()
        changed = 0
        with self.database.transaction(immediate=True) as connection:
            rows = connection.execute(
                "SELECT run_id, errors_json FROM analysis_runs WHERE status = 'running'"
            ).fetchall()
            for row in rows:
                errors = json.loads(row["errors_json"])
                errors.append(message)
                connection.execute(
                    "UPDATE analysis_runs SET status = 'interrupted', "
                    "finished_at = ?, errors_json = ? WHERE run_id = ?",
                    (now, json.dumps(errors), row["run_id"]),
                )
                changed += 1
        return changed

    def set_latest(
        self,
        *,
        snapshot_run_id: str,
        lens: AnalysisLens,
        ticker: str | None,
        artifact_id: str,
        input_hash: str,
        updated_at: datetime,
    ) -> None:
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO analysis_latest_lens("
                "snapshot_run_id, lens, ticker, artifact_id, input_hash, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(snapshot_run_id, lens, ticker) DO UPDATE SET "
                "artifact_id=excluded.artifact_id, input_hash=excluded.input_hash, "
                "updated_at=excluded.updated_at",
                (
                    snapshot_run_id,
                    lens,
                    (ticker or "PORTFOLIO").upper(),
                    artifact_id,
                    input_hash,
                    updated_at.isoformat(),
                ),
            )
            # Keep the V1 page pointer current during the compatibility window so
            # older deployments can roll back without losing the newest artifact.
            connection.execute(
                "INSERT INTO analysis_latest("
                "snapshot_run_id, page, ticker, artifact_id, input_hash, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(snapshot_run_id, page, ticker) DO UPDATE SET "
                "artifact_id=excluded.artifact_id, input_hash=excluded.input_hash, "
                "updated_at=excluded.updated_at",
                (
                    snapshot_run_id,
                    page_for_lens(lens),
                    (ticker or "PORTFOLIO").upper(),
                    artifact_id,
                    input_hash,
                    updated_at.isoformat(),
                ),
            )

    def latest_id(
        self,
        *,
        snapshot_run_id: str,
        lens: AnalysisLens,
        ticker: str | None,
    ) -> str | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT artifact_id FROM analysis_latest_lens "
                "WHERE snapshot_run_id = ? AND lens = ? AND ticker = ?",
                (snapshot_run_id, lens, (ticker or "PORTFOLIO").upper()),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    "SELECT artifact_id FROM analysis_latest "
                    "WHERE snapshot_run_id = ? AND page = ? AND ticker = ?",
                    (
                        snapshot_run_id,
                        page_for_lens(lens),
                        (ticker or "PORTFOLIO").upper(),
                    ),
                ).fetchone()
        return row["artifact_id"] if row is not None else None


__all__ = ["MIGRATIONS", "AnalysisRunRepository"]
