"""Validate that a SemVer release tag matches every shipped package surface."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^v(?P<version>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)$")


def _versions() -> dict[str, str]:
    root_pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    backend_pyproject = tomllib.loads(
        (ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    )
    web_package = json.loads((ROOT / "apps" / "web" / "package.json").read_text(encoding="utf-8"))
    web_lock = json.loads((ROOT / "apps" / "web" / "package-lock.json").read_text(encoding="utf-8"))
    init_text = (ROOT / "backend" / "src" / "trading_max" / "__init__.py").read_text(
        encoding="utf-8"
    )
    init_match = re.search(r'__version__\s*=\s*"([^"]+)"', init_text)
    if init_match is None:
        raise SystemExit("backend package version is missing")
    openapi = json.loads((ROOT / "contracts" / "openapi.json").read_text(encoding="utf-8"))
    return {
        "root pyproject": root_pyproject["project"]["version"],
        "backend pyproject": backend_pyproject["project"]["version"],
        "web package": web_package["version"],
        "web lock": web_lock["version"],
        "backend package": init_match.group(1),
        "OpenAPI": openapi["info"]["version"],
    }


def main(argv: list[str] | None = None) -> int:
    tag = (argv or sys.argv[1:])[0] if (argv or sys.argv[1:]) else ""
    match = SEMVER.fullmatch(tag)
    if match is None:
        print("release tag must use vMAJOR.MINOR.PATCH, for example v1.0.0")
        return 1
    expected = ".".join((match.group("version"), match.group("minor"), match.group("patch")))
    versions = _versions()
    mismatches = {surface: version for surface, version in versions.items() if version != expected}
    if mismatches:
        print(f"release tag {tag} expects version {expected}")
        for surface, version in mismatches.items():
            print(f"- {surface}: {version}")
        return 1
    print(f"release version {tag} is consistent across {len(versions)} surfaces")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
