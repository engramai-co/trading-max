"""Gate, enable and run bounded immutable packing on an operator-managed host."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.pack_maintenance import compact_manifests, enable, pack_repository, pack_state
from trading_max.storage_compatibility import verify_retained_readers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--verified-backup-id", required=True)
    parser.add_argument("--max-files", type=int, default=4096)
    parser.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    parser.add_argument("command", choices=("check", "activate", "state", "backups", "catalog"))
    args = parser.parse_args()
    service = args.service_root.resolve(strict=True)
    state = args.state_root.resolve(strict=True)
    repository = BackupRepository(service / "backups/repository")
    with exclusive_lock(service / ".deployment.lock"), exclusive_lock(repository.lock):
        readers = verify_retained_readers(service, object_packs=True)
        manifest = repository.read_manifest(args.verified_backup_id)
        if manifest.get("sourceState") != str(state):
            raise ValueError("recovery snapshot belongs to another state")
        if datetime.fromisoformat(manifest["createdAt"]) < datetime.now(UTC) - timedelta(days=1):
            raise ValueError("packing requires a recovery point from the last 24 hours")
        if not repository._verify(manifest).get("snapshotRunId"):
            raise ValueError("packing requires independent published-state recovery")
        result = {"readers": readers, "backupId": args.verified_backup_id}
        journals = service / "maintenance/object-packs"
        budgets = {"max_files": args.max_files, "max_bytes": args.max_bytes}
        if args.command == "activate":
            enable(state)
            enable(repository.root)
            result["enabled"] = True
        elif args.command == "state":
            result["state"] = pack_state(state, journals / "state", **budgets)
        elif args.command == "backups":
            result["backups"] = pack_repository(repository, journals / "backups", **budgets)
        elif args.command == "catalog":
            result["catalog"] = compact_manifests(repository, max_files=args.max_files)
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
