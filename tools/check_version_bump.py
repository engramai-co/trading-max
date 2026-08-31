"""Require every pull request to advance Trading Max by one SemVer increment."""

from __future__ import annotations

import argparse

from release_contract import (
    ReleaseContractError,
    validate_initial_version,
    validate_version_increment,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base")
    parser.add_argument("--head", required=True)
    parser.add_argument("--initial", action="store_true")
    arguments = parser.parse_args()
    try:
        if arguments.initial:
            validate_initial_version(arguments.head)
        elif arguments.base:
            validate_version_increment(arguments.base, arguments.head)
        else:
            raise ReleaseContractError("--base is required unless --initial is used")
    except ReleaseContractError as error:
        print(f"version bump failed: {error}")
        return 1
    if arguments.initial:
        print(f"initial version baseline passed: {arguments.head}")
    else:
        print(f"version bump passed: {arguments.base} -> {arguments.head}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
