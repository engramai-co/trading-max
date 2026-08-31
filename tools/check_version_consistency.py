"""Validate the VERSION file against every shipped package surface."""

from __future__ import annotations

import argparse

from release_contract import ROOT, ReleaseContractError, validate_project_versions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected")
    arguments = parser.parse_args()
    expected = arguments.expected or (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    try:
        versions = validate_project_versions(expected)
    except (OSError, KeyError, TypeError, ReleaseContractError) as error:
        print(f"version consistency failed: {error}")
        return 1
    print(f"version consistency passed across {len(versions)} surfaces: {expected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
