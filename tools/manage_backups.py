"""Create, verify or restore an independently deduplicated recovery snapshot."""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from trading_max.background_backup import deployment_requested, run_background
from trading_max.backup_repository import BackupRepository
from trading_max.checkpoint_migration import migrate_checkpoint
from trading_max.pack_maintenance import nightly_packs
from trading_max.physical_recovery import archive_checkpoint
from trading_max.recovery_checkpoint import checkpoint
from trading_max.service_retention import ServiceRetention
from trading_max.storage_budget import nightly_storage


def report_progress(details: dict) -> None:
    # Keep stdout a single machine-readable result, including for deployments.
    print(json.dumps({"at": datetime.now(UTC).isoformat(), **details}), file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--max-seconds", type=float, default=1800)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--state-root", type=Path, required=True)
    create.add_argument("--label", default="manual")
    create.add_argument(
        "--artifact-encoding", choices=("physical", "logical", "sealed"), default="physical"
    )
    create.add_argument("--retain-for-service", type=Path)
    capture = sub.add_parser("checkpoint")
    capture.add_argument("--state-root", type=Path, required=True)
    capture.add_argument("--label", default="deployment")
    capture.add_argument("--wait-seconds", type=float, default=30)
    archive = sub.add_parser("archive-checkpoint")
    archive.add_argument("checkpoint_id")
    background = sub.add_parser("background")
    background.add_argument("--state-root", type=Path, required=True)
    background.add_argument("--service-root", type=Path)
    background.add_argument("--force", action="store_true")
    sub.add_parser("status")
    archive_import = sub.add_parser("import-archive")
    archive_import.add_argument("archive", type=Path)
    archive_import.add_argument("--max-bytes", type=int, default=64 * 1024**3)
    checkpoint_import = sub.add_parser("import-checkpoint")
    checkpoint_import.add_argument("directory", type=Path)
    checkpoint_import.add_argument("--retire", action="store_true")
    verify = sub.add_parser("verify")
    verify.add_argument("backup_id")
    restore = sub.add_parser("restore")
    restore.add_argument("backup_id")
    restore.add_argument("destination", type=Path)
    args = parser.parse_args()
    if not 0 < args.max_seconds < float("inf"):
        parser.error("--max-seconds must be finite and positive")
    deadline = time.monotonic() + args.max_seconds
    last_report = 0.0
    last_phase = None

    def progress(details: dict) -> None:
        nonlocal last_report, last_phase
        if args.command == "import-checkpoint" and deployment_requested(
            args.repository.expanduser().resolve().parent.parent
        ):
            raise InterruptedError("checkpoint import yielded to deployment; rerun to resume")
        if (
            args.command == "background"
            and args.service_root
            and deployment_requested(args.service_root)
        ):
            raise InterruptedError(
                "backup yielded to requested deployment; durable progress retained"
            )
        if (
            details["phase"] != last_phase
            or time.monotonic() - last_report >= 5
            or details["phase"].endswith("published")
        ):
            report_progress(details)
            last_report = time.monotonic()
            last_phase = details["phase"]
        # Check between files and maintenance stages, never interrupt an atomic
        # publication or a journaled removal halfway through its write.
        if time.monotonic() > deadline:
            raise TimeoutError("backup time budget exceeded; inspect progress before retrying")

    repository = BackupRepository(args.repository, progress=progress)
    if args.command == "status":
        path = repository.root / "background-status.json"
        result = json.loads(path.read_bytes()) if path.exists() else {"status": "not-started"}
    elif args.command == "checkpoint":
        result = checkpoint(
            repository, args.state_root, label=args.label, wait_seconds=args.wait_seconds
        )
    elif args.command == "archive-checkpoint":
        result = archive_checkpoint(repository, args.checkpoint_id)
    elif args.command == "background":

        def interrupted(*_):
            raise InterruptedError("background backup interrupted; durable progress retained")

        signal.signal(signal.SIGTERM, interrupted)

        def maintain(result):
            if not args.service_root:
                return None
            maintenance = ServiceRetention(args.service_root)
            if maintenance.repository.root != repository.root:
                raise ValueError("managed backup must use this service's recovery repository")
            maintenance.repository.progress = progress
            return {
                "packing": nightly_packs(
                    maintenance.service, args.state_root, result["id"], progress=progress
                ),
                "retention": maintenance.maintain_repository(result["id"]),
                "storage": nightly_storage(maintenance.service, args.state_root),
            }

        result = run_background(
            repository,
            args.state_root,
            service=args.service_root,
            force=args.force,
            maintain=maintain,
            wait_for_deployment=20,
        )
    elif args.command == "create":
        maintenance = ServiceRetention(args.retain_for_service) if args.retain_for_service else None
        if maintenance and maintenance.repository.root != repository.root:
            raise ValueError("nightly retention must use this service's backup repository")
        result = repository.create(
            args.state_root, label=args.label, artifact_encoding=args.artifact_encoding
        )
        if maintenance:
            maintenance.repository.progress = progress
            try:
                progress({"phase": "packing", "backupId": result["id"]})
                result["packing"] = nightly_packs(
                    maintenance.service, args.state_root, result["id"], progress=progress
                )
                progress({"phase": "retention", "backupId": result["id"]})
                result["retention"] = maintenance.maintain_repository(result["id"])
            finally:
                # A blocked cleanup must not hide continuing capacity growth.
                report_progress({"phase": "storage-census"})
                result["storage"] = nightly_storage(maintenance.service, args.state_root)
    elif args.command == "import-archive":
        result = repository.import_archive(args.archive, max_bytes=args.max_bytes)
    elif args.command == "import-checkpoint":
        result = migrate_checkpoint(repository, args.directory, retire=args.retire)
    elif args.command == "verify":
        result = repository.verify(args.backup_id)
    else:
        result = repository.restore(args.backup_id, args.destination)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
