"""Durable, private storage for manually exported Trading 212 CFD ledgers."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from trading_max.analytics.cfd import (
    CfdAnalysis,
    CfdLedger,
    analyse_cfd_ledger,
    combine_cfd_ledgers,
    parse_cfd_csv_bytes,
)

MAX_CFD_IMPORT_BYTES = 1_000_000
MANIFEST_SCHEMA_VERSION = 1


class CfdImportError(ValueError):
    """Reject an invalid import without persisting it."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    content = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    _atomic_write(path, content + b"\n")


def _safe_filename(value: str) -> str:
    filename = value.strip().replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or filename in {".", ".."}:
        raise CfdImportError("a source filename is required")
    if not filename.lower().endswith(".csv"):
        raise CfdImportError("Trading 212 CFD imports must use a .csv filename")
    return filename[:255]


def _iso(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    text = str(value).strip()
    return text or None


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _manifest_timestamp(value: object, *, field: str) -> datetime | None:
    if value is None or not str(value).strip():
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise RuntimeError(f"CFD import manifest contains an invalid {field}") from exc
    return _as_utc(parsed)


def _valid_digest(value: object) -> str:
    digest = str(value or "")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise RuntimeError("CFD import manifest contains an invalid file digest")
    return digest


class CfdImportStore:
    """Own originals, a manifest, and a rebuildable canonical CFD ledger.

    Originals are content-addressed and never overwritten. The canonical
    ledger and analysis are deterministic caches that can be rebuilt from the
    manifest whenever the parser version changes.
    """

    def __init__(
        self,
        state_root: Path,
        *,
        stale_after_days: int = 14,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        if stale_after_days <= 0:
            raise ValueError("stale_after_days must be positive")
        self.root = state_root.expanduser().resolve() / "imports" / "trading212" / "cfd"
        self.originals_root = self.root / "originals"
        self.manifest_path = self.root / "manifest.json"
        self.ledger_path = self.root / "ledger.json"
        self.analysis_path = self.root / "analysis.json"
        self.stale_after_days = stale_after_days
        self.clock = clock
        self._lock = threading.RLock()

    def _empty_manifest(self) -> dict[str, Any]:
        return {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "parser_version": "uninitialized",
            "account_status": "active",
            "files": [],
            "summary": {},
        }

    def _manifest(self) -> dict[str, Any]:
        if not self.manifest_path.is_file():
            return self._empty_manifest()
        try:
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("CFD import manifest is unreadable") from exc
        if (
            not isinstance(payload, dict)
            or payload.get("schema_version") != MANIFEST_SCHEMA_VERSION
            or not isinstance(payload.get("files"), list)
        ):
            raise RuntimeError("CFD import manifest has an unsupported schema")
        if payload.get("account_status", "active") not in {"active", "retired"}:
            raise RuntimeError("CFD import manifest contains an invalid account status")
        return payload

    def _parsed_files(self, manifest: dict[str, Any]):
        parsed = []
        for raw in manifest.get("files", []):
            if not isinstance(raw, dict):
                raise RuntimeError("CFD import manifest contains an invalid file entry")
            digest = _valid_digest(raw.get("sha256"))
            path = self.originals_root / f"{digest}.csv"
            if not path.is_file():
                raise RuntimeError(f"CFD original is missing for digest {digest}")
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != digest:
                raise RuntimeError(f"CFD original digest mismatch for {digest}")
            try:
                parsed.append(
                    parse_cfd_csv_bytes(
                        content,
                        source_name=str(raw.get("filename") or path.name),
                    )
                )
            except ValueError as exc:
                raise RuntimeError(f"CFD original is no longer parseable for {digest}") from exc
        return parsed

    def build_ledger(self) -> CfdLedger | None:
        with self._lock:
            parsed = self._parsed_files(self._manifest())
            return combine_cfd_ledgers(parsed) if parsed else None

    def build_analysis(self) -> CfdAnalysis | None:
        ledger = self.build_ledger()
        return analyse_cfd_ledger(ledger) if ledger is not None else None

    def _status(self, manifest: dict[str, Any]) -> dict[str, Any]:
        raw_files = manifest.get("files", [])
        if any(not isinstance(item, dict) for item in raw_files):
            raise RuntimeError("CFD import manifest contains an invalid file entry")
        files = [dict(item) for item in raw_files]
        for item in files:
            _valid_digest(item.get("sha256"))
        summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
        imported_at = [
            parsed
            for item in files
            if (
                parsed := _manifest_timestamp(
                    item.get("imported_at"), field="file imported_at timestamp"
                )
            )
            is not None
        ]
        last_imported_at = _manifest_timestamp(
            manifest.get("last_imported_at"), field="last_imported_at timestamp"
        )
        if last_imported_at is None and imported_at:
            last_imported_at = max(imported_at)
        now = _as_utc(self.clock())
        account_status = str(manifest.get("account_status") or "active")
        stale_reminders_enabled = account_status == "active"
        is_stale = bool(
            stale_reminders_enabled
            and last_imported_at is not None
            and now - last_imported_at > timedelta(days=self.stale_after_days)
        )
        try:
            total_raw_rows = sum(int(item.get("raw_rows") or 0) for item in files)
            unique_events = int(summary.get("unique_events") or 0)
            duplicate_events = int(summary.get("duplicate_events") or 0)
        except (TypeError, ValueError) as exc:
            raise RuntimeError("CFD import manifest contains invalid event counts") from exc
        summary_warnings = summary.get("warnings", [])
        if not isinstance(summary_warnings, list):
            raise RuntimeError("CFD import manifest contains invalid warnings")
        return {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "parser_version": str(manifest.get("parser_version") or "uninitialized"),
            "files": files,
            "imported_files": len(files),
            "total_raw_rows": total_raw_rows,
            "unique_events": unique_events,
            "duplicate_events": duplicate_events,
            "coverage_start_date": summary.get("coverage_start_date"),
            "coverage_end_date": summary.get("coverage_end_date"),
            "latest_event_at": summary.get("latest_event_at"),
            "last_imported_at": _iso(last_imported_at),
            "stale_after_days": self.stale_after_days,
            "is_stale": is_stale,
            "account_status": account_status,
            "stale_reminders_enabled": stale_reminders_enabled,
            "warnings": [str(item) for item in summary_warnings],
        }

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status(self._manifest())

    def set_account_status(self, account_status: str) -> dict[str, Any]:
        if account_status not in {"active", "retired"}:
            raise ValueError("CFD account status must be active or retired")
        with self._lock:
            manifest = self._manifest()
            candidate = {**manifest, "account_status": account_status}
            _atomic_json(self.manifest_path, candidate)
            return self._status(candidate)

    def _rebuild(self, manifest: dict[str, Any]) -> tuple[dict[str, Any], CfdLedger, CfdAnalysis]:
        ledger = combine_cfd_ledgers(self._parsed_files(manifest))
        analysis = analyse_cfd_ledger(ledger)
        return self._manifest_with_summary(manifest, ledger), ledger, analysis

    @staticmethod
    def _manifest_with_summary(manifest: dict[str, Any], ledger: CfdLedger) -> dict[str, Any]:
        ledger_payload = ledger.to_dict()
        return {
            **manifest,
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "parser_version": ledger.parser_version,
            "summary": {
                "unique_events": len(ledger.events),
                "duplicate_events": ledger.duplicate_event_count,
                "coverage_start_date": ledger_payload.get("coverage_start"),
                "coverage_end_date": ledger_payload.get("coverage_end"),
                "latest_event_at": ledger_payload.get("latest_event_at"),
                "account_currencies": list(ledger.account_currencies),
                "warnings": list(ledger.warnings),
            },
        }

    def _write_rebuildable_caches(self, ledger: CfdLedger, analysis: CfdAnalysis) -> None:
        _atomic_json(self.ledger_path, ledger.to_dict())
        _atomic_json(self.analysis_path, analysis.to_dict())

    def _persist_original(self, digest: str, content: bytes) -> Path:
        original = self.originals_root / f"{digest}.csv"
        if original.is_file():
            if hashlib.sha256(original.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"CFD original digest mismatch for {digest}")
        else:
            _atomic_write(original, content)
        return original

    def import_bytes(
        self,
        filename: str,
        content: bytes,
        *,
        imported_at: datetime | None = None,
    ) -> dict[str, Any]:
        safe_name = _safe_filename(filename)
        if not content:
            raise CfdImportError("the CFD CSV is empty")
        if len(content) > MAX_CFD_IMPORT_BYTES:
            raise CfdImportError("the CFD CSV exceeds the 1 MB import limit")
        try:
            parsed = parse_cfd_csv_bytes(content, source_name=safe_name)
        except (UnicodeError, ValueError) as exc:
            raise CfdImportError(str(exc)) from exc
        digest = hashlib.sha256(content).hexdigest()
        if parsed.file_sha256 != digest:
            raise RuntimeError("CFD parser returned a mismatched file digest")

        with self._lock:
            manifest = self._manifest()
            imported = _as_utc(imported_at or self.clock())
            existing = next(
                (
                    item
                    for item in manifest.get("files", [])
                    if isinstance(item, dict) and item.get("sha256") == digest
                ),
                None,
            )
            if existing is not None:
                self._persist_original(digest, content)
                candidate = {**manifest, "last_imported_at": imported.isoformat()}
                # Duplicate uploads are economically idempotent but still
                # rebuild deterministic caches. This repairs missing caches
                # and upgrades old parser versions without changing originals.
                candidate, ledger, analysis = self._rebuild(candidate)
                self._write_rebuildable_caches(ledger, analysis)
                _atomic_json(self.manifest_path, candidate)
                return {
                    "status": "duplicate",
                    "file": dict(existing),
                    "ledger": self._status(candidate),
                }

            parsed_payload = parsed.to_dict()
            file_entry = {
                "sha256": digest,
                "filename": safe_name,
                "imported_at": imported.isoformat(),
                "raw_rows": parsed.raw_row_count,
                "canonical_events": len(parsed.events),
                "coverage_start_date": parsed_payload.get("coverage_start"),
                "coverage_end_date": parsed_payload.get("coverage_end"),
                "latest_event_at": parsed_payload.get("latest_event_at"),
                "warnings": list(parsed.warnings),
            }
            files = [dict(item) for item in manifest.get("files", []) if isinstance(item, dict)]
            files.append(file_entry)
            candidate = {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "parser_version": parsed.parser_version,
                "account_status": manifest.get("account_status", "active"),
                "files": files,
                "last_imported_at": imported.isoformat(),
            }
            try:
                ledger = combine_cfd_ledgers([*self._parsed_files(manifest), parsed])
            except ValueError as exc:
                raise CfdImportError(str(exc)) from exc
            analysis = analyse_cfd_ledger(ledger)
            candidate = self._manifest_with_summary(candidate, ledger)
            self._persist_original(digest, content)
            self._write_rebuildable_caches(ledger, analysis)
            _atomic_json(self.manifest_path, candidate)
            return {
                "status": "imported",
                "file": file_entry,
                "ledger": self._status(candidate),
            }


__all__ = [
    "MANIFEST_SCHEMA_VERSION",
    "MAX_CFD_IMPORT_BYTES",
    "CfdImportError",
    "CfdImportStore",
]
