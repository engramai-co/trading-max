"""Resolve the explicit release policy without weakening shared release gates."""

from __future__ import annotations

import argparse
from pathlib import Path

from release_contract import ReleaseContractError, resolve_release_policy


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="")
    parser.add_argument("--head", required=True)
    for option in ("product", "documentation", "hotfix", "documentation-release"):
        parser.add_argument("--" + option, choices=("true", "false"), required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        mode = resolve_release_policy(
            base=args.base,
            head=args.head,
            product=args.product == "true",
            documentation=args.documentation == "true",
            hotfix=args.hotfix == "true",
            documentation_release=args.documentation_release == "true",
        )
    except ReleaseContractError as error:
        print(f"release policy failed: {error}")
        return 1
    with args.github_output.open("a", encoding="utf-8") as output:
        output.write(f"mode={mode}\n")
    print(f"release policy: {mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
