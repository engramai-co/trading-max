"""Generate the checked-in API contract snapshot."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Keep this operator/CI tool runnable from a fresh checkout without requiring
# callers to remember the repository's two-package import path.
ROOT = Path(__file__).resolve().parents[1]
for import_root in (ROOT, ROOT / "backend" / "src"):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))


def main() -> int:
    from services.api.trading_max_api.app import create_app

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("contracts/openapi.json"),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the checked-in contract differs from the generated schema",
    )
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    generated = (
        json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    if args.check:
        if not output.is_file():
            print(f"missing OpenAPI contract: {output}")
            return 1
        current = output.read_text(encoding="utf-8")
        if current != generated:
            print(f"OpenAPI contract is stale: {output}")
            return 1
        print(f"OpenAPI contract is current: {output}")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(generated, encoding="utf-8")
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
