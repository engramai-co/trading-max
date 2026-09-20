"""Measure the whole macOS service installation without pruning financial data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from trading_max.storage_budget import write_budget_report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--logs-root", type=Path, default=Path.home() / "Library/Logs/Trading Max")
    parser.add_argument("--legacy-backups", type=Path, default=Path.home() / "Backups/Trading Max")
    args = parser.parse_args()
    result = write_budget_report(
        args.service_root.resolve(), args.state_root.resolve(), args.logs_root, args.legacy_backups
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
