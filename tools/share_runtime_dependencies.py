"""Deduplicate immutable installed dependencies in an isolated or retained release."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from trading_max.shared_runtime import share_dependencies


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--pool", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(share_dependencies(args.release, args.pool)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
