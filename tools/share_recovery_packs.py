"""Gate and run bounded sharing of immutable recovery packs."""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.background_backup import deployment_requested
from trading_max.backup_repository import BackupRepository, atomic_json, exclusive_lock
from trading_max.pack_maintenance import NIGHTLY_BYTES, NIGHTLY_FILES, NIGHTLY_SECONDS, PackWindow
from trading_max.recovery_pack_sharing import POLICY, share
from trading_max.service_retention import ServiceRetention
from trading_max.storage_compatibility import verify_retained_readers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--verified-backup-id", required=True)
    parser.add_argument("--max-files", type=int, default=NIGHTLY_FILES)
    parser.add_argument("--max-bytes", type=int, default=NIGHTLY_BYTES)
    parser.add_argument("--max-seconds", type=float, default=NIGHTLY_SECONDS)
    parser.add_argument("command", choices=("check", "activate", "run"))
    args = parser.parse_args()
    if min(args.max_files, args.max_bytes, args.max_seconds) <= 0 or not math.isfinite(
        args.max_seconds
    ):
        parser.error("recovery sharing budgets must be finite and positive")
    service = args.service_root.resolve(strict=True)
    state = args.state_root.resolve(strict=True)
    started = time.monotonic()

    def progress(details):
        if deployment_requested(service):
            raise InterruptedError("recovery sharing yielded to deployment; originals retained")

    repository = BackupRepository(service / "backups/repository", progress=progress)
    with exclusive_lock(service / ".deployment.lock"), exclusive_lock(repository.lock):
        context = ServiceRetention(service, repository=repository)._context()
        record = context["records"].get(Path(context["active"]).name, {})
        if record.get("state") != str(state):
            raise ValueError("recovery sharing must use the active application state")
        readers = verify_retained_readers(service, object_packs=True)
        manifest = repository.read_manifest(args.verified_backup_id)
        if manifest.get("sourceState") != str(state):
            raise ValueError("recovery belongs to another state")
        if datetime.fromisoformat(manifest["createdAt"]) < datetime.now(UTC) - timedelta(days=1):
            raise ValueError("recovery sharing requires recovery from the last 24 hours")
        sealed_readers = verify_retained_readers(service, sealed_blobs=True)
        verification = repository._verify_full(manifest)
        if not verification.get("snapshotRunId"):
            raise ValueError("recovery sharing requires a verified published state")
        result = {
            "readers": readers,
            "sealedReaders": sealed_readers,
            "backupId": args.verified_backup_id,
            "verification": verification,
        }
        if args.command == "activate":
            atomic_json(repository.root / POLICY, {"schemaVersion": 1, "enabled": True})
            result["enabled"] = True
        elif args.command == "run":
            window = PackWindow(
                args.max_seconds, should_yield=lambda: deployment_requested(service)
            )
            result["sharing"] = share(
                repository,
                service / "maintenance/object-packs/recovery-sharing",
                max_files=args.max_files,
                max_bytes=args.max_bytes,
                window=window,
            )
            result["limitReason"] = window.reason
            result["sharingSeconds"] = round(time.monotonic() - window.started, 3)
            result["postVerification"] = repository._verify_full(manifest)
        result["seconds"] = round(time.monotonic() - started, 3)
        atomic_json(service / "maintenance/recovery-sharing" / (args.command + ".json"), result)
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
