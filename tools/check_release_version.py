"""Validate that a SemVer release tag matches every shipped package surface."""

from __future__ import annotations

import sys

from release_contract import ReleaseContractError, validate_project_versions


def main(argv: list[str] | None = None) -> int:
    arguments = argv if argv is not None else sys.argv[1:]
    tag = arguments[0] if arguments else ""
    if not tag.startswith("v"):
        print("release tag must use vMAJOR.MINOR.PATCH, for example v1.0.0")
        return 1
    expected = tag.removeprefix("v")
    try:
        versions = validate_project_versions(expected)
    except (OSError, KeyError, TypeError, ReleaseContractError) as error:
        print(f"release version validation failed: {error}")
        return 1
    print(f"release version {tag} is consistent across {len(versions)} surfaces")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
