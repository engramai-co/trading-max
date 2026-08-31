"""Require a dated, categorized changelog section for the current VERSION."""

from __future__ import annotations

import argparse
from pathlib import Path

from release_contract import ReleaseContractError, find_changelog_release


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected", required=True)
    parser.add_argument("--path", default="CHANGELOG.md")
    arguments = parser.parse_args()
    try:
        release = find_changelog_release(
            Path(arguments.path).read_text(encoding="utf-8"),
            arguments.expected,
        )
    except (OSError, ReleaseContractError) as error:
        print(f"changelog check failed: {error}")
        return 1
    print(f"changelog check passed: {release.version} ({release.released_on})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
