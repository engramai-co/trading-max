"""Plan first; gradually clean verified historical deployment copies."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from trading_max.backup_repository import atomic_json
from trading_max.service_retention import ServiceRetention


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--output", type=Path, required=True)
    apply = commands.add_parser("apply")
    apply.add_argument("--plan", type=Path, required=True)
    apply.add_argument("--verified-backup-id", required=True)
    apply.add_argument("--max-items", type=int, default=2)
    apply.add_argument("--max-bytes", type=int, default=5_000_000_000)
    args = parser.parse_args()
    maintenance = ServiceRetention(args.service_root)
    if args.command == "plan":
        result = maintenance.plan()
        atomic_json(args.output, result)
        print(
            json.dumps(
                {
                    "plan": str(args.output),
                    "candidates": len(result["items"]),
                    "candidateBytes": result["candidateBytes"],
                    "protected": result["protected"],
                }
            )
        )
    else:
        print(
            json.dumps(
                maintenance.apply(
                    json.loads(args.plan.read_text()),
                    verified_backup_id=args.verified_backup_id,
                    max_items=args.max_items,
                    max_bytes=args.max_bytes,
                )
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
