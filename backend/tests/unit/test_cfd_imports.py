from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from trading_max.ingestion.cfd_imports import CfdImportError, CfdImportStore

TRANSACTION_HEADERS = [
    "Record Type",
    "Date (UTC)",
    "Account currency",
    "Transaction ID",
    "Transaction type",
    "Amount (account currency)",
    "Info",
]


def _transaction_csv(rows: list[tuple[str, str, str, str]]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=TRANSACTION_HEADERS, lineterminator="\n")
    writer.writeheader()
    for transaction_id, transaction_type, amount, occurred_at in rows:
        writer.writerow(
            {
                "Record Type": "Transaction",
                "Date (UTC)": occurred_at,
                "Account currency": "GBP",
                "Transaction ID": transaction_id,
                "Transaction type": transaction_type,
                "Amount (account currency)": amount,
                "Info": ("Transfer from Invest account" if transaction_type == "Transfer" else ""),
            }
        )
    return stream.getvalue().encode()


def test_import_store_keeps_originals_and_rebuildable_caches_under_state_root(
    tmp_path: Path,
) -> None:
    state_root = tmp_path / "external-state"
    current = [datetime(2026, 8, 1, 12, tzinfo=UTC)]
    store = CfdImportStore(state_root, clock=lambda: current[0])
    first = _transaction_csv([("transaction-1", "Deposit", "100", "2025-01-01T00:00:00Z")])
    overlap = _transaction_csv(
        [
            ("transaction-1", "Deposit", "100", "2025-01-01T00:00:00Z"),
            ("transaction-2", "Transfer", "25", "2025-01-02T00:00:00Z"),
        ]
    )

    first_result = store.import_bytes("../first.csv", first)
    second_result = store.import_bytes("overlap.csv", overlap)

    assert store.root == state_root.resolve() / "imports" / "trading212" / "cfd"
    assert first_result["file"]["filename"] == "first.csv"
    assert second_result["status"] == "imported"
    assert second_result["ledger"]["total_raw_rows"] == 3
    assert second_result["ledger"]["unique_events"] == 2
    assert second_result["ledger"]["duplicate_events"] == 1
    assert second_result["ledger"]["coverage_end_date"] == "2025-01-02T00:00:00Z"
    assert len(list(store.originals_root.glob("*.csv"))) == 2
    assert store.manifest_path.is_file()
    assert store.ledger_path.is_file()
    assert store.analysis_path.is_file()

    manifest = json.loads(store.manifest_path.read_text(encoding="utf-8"))
    ledger_cache = json.loads(store.ledger_path.read_text(encoding="utf-8"))
    analysis_cache = json.loads(store.analysis_path.read_text(encoding="utf-8"))
    assert len(manifest["files"]) == 2
    assert manifest["summary"]["duplicate_events"] == 1
    assert len(ledger_cache["events"]) == 2
    assert analysis_cache["cash_flows"]["account_cash_flow"] == "125"
    assert analysis_cache["cash_flows"]["household_external_flow"] == "100"

    # Staleness follows the upload clock, not the deliberately old event date.
    assert store.status()["is_stale"] is False
    current[0] += timedelta(days=15)
    assert store.status()["is_stale"] is True

    retired = store.set_account_status("retired")
    assert retired["account_status"] == "retired"
    assert retired["stale_reminders_enabled"] is False
    assert retired["is_stale"] is False
    assert CfdImportStore(state_root, clock=lambda: current[0]).status()["account_status"] == (
        "retired"
    )

    active = store.set_account_status("active")
    assert active["stale_reminders_enabled"] is True
    assert active["is_stale"] is True

    # A duplicate upload is also a repair path for rebuildable caches and an
    # accidentally missing content-addressed original.
    overlap_original = store.originals_root / f"{second_result['file']['sha256']}.csv"
    overlap_original.unlink()
    store.ledger_path.unlink()
    store.analysis_path.unlink()

    duplicate = store.import_bytes("same-overlap.csv", overlap)

    assert duplicate["status"] == "duplicate"
    assert duplicate["ledger"]["imported_files"] == 2
    assert duplicate["ledger"]["unique_events"] == 2
    assert duplicate["ledger"]["is_stale"] is False
    assert duplicate["ledger"]["account_status"] == "active"
    assert duplicate["ledger"]["last_imported_at"] == current[0].isoformat()
    assert len(list(store.originals_root.glob("*.csv"))) == 2
    assert overlap_original.read_bytes() == overlap
    assert len(json.loads(store.ledger_path.read_text(encoding="utf-8"))["events"]) == 2
    assert store.analysis_path.is_file()


def test_conflicting_overlap_is_rejected_before_a_new_original_or_manifest_entry(
    tmp_path: Path,
) -> None:
    store = CfdImportStore(tmp_path / "state")
    original = _transaction_csv([("transaction-1", "Deposit", "100", "2026-01-01T00:00:00Z")])
    conflict = _transaction_csv([("transaction-1", "Deposit", "101", "2026-01-01T00:00:00Z")])
    store.import_bytes("original.csv", original)
    before_manifest = store.manifest_path.read_bytes()

    with pytest.raises(CfdImportError, match="conflicting CFD rows"):
        store.import_bytes("conflict.csv", conflict)

    assert store.manifest_path.read_bytes() == before_manifest
    assert len(list(store.originals_root.glob("*.csv"))) == 1
    assert store.status()["imported_files"] == 1


def test_store_rejects_tampered_manifest_digest_without_path_resolution(
    tmp_path: Path,
) -> None:
    store = CfdImportStore(tmp_path / "state")
    store.root.mkdir(parents=True)
    store.manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "parser_version": "test",
                "files": [{"sha256": "../outside", "filename": "bad.csv"}],
                "summary": {},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="invalid file digest"):
        store.build_ledger()
