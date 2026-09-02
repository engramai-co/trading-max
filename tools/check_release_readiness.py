"""Validate engineering or public-release readiness without guessing legal choices."""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINEERING_FILES = (
    ".github/workflows/auto-release.yml",
    ".github/workflows/release-contract.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/feature.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/dependabot.yml",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "THIRD_PARTY_NOTICES.md",
    "TRADEMARKS.md",
    "VERSION",
    "docs/installation/local-installation.md",
    "docs/operations/agent-local-deployment-runbook.md",
)
LICENSE_FILES = ("LICENSE", "LICENSE.md", "LICENSE.txt")
PUBLIC_FILES = ("LICENSE", "NOTICE")
PUBLIC_METADATA = {
    "CODE_OF_CONDUCT.md": ("contact@ingramai.co",),
    "README.md": (
        "Apache License 2.0",
        "THIRD_PARTY_NOTICES.md",
    ),
    "SECURITY.md": ("contact@ingramai.co",),
    "pyproject.toml": (
        'license = "Apache-2.0"',
        'Repository = "https://github.com/engramai-co/trading-max"',
    ),
    "backend/pyproject.toml": (
        'license = "Apache-2.0"',
        'Repository = "https://github.com/engramai-co/trading-max"',
    ),
    "package.json": (
        '"license": "Apache-2.0"',
        '"url": "git+https://github.com/engramai-co/trading-max.git"',
    ),
    "apps/web/package.json": (
        '"license": "Apache-2.0"',
        '"url": "git+https://github.com/engramai-co/trading-max.git"',
    ),
}


def missing_engineering_files() -> list[str]:
    return [path for path in ENGINEERING_FILES if not (ROOT / path).is_file()]


def public_release_failures() -> list[str]:
    failures = [path for path in PUBLIC_FILES if not (ROOT / path).is_file()]
    for path, markers in PUBLIC_METADATA.items():
        content = (ROOT / path).read_text(encoding="utf-8")
        for marker in markers:
            if marker not in content:
                failures.append(f"{path}: missing public-release marker {marker!r}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--public",
        action="store_true",
        help="also require an owner-approved license before publishing",
    )
    arguments = parser.parse_args()

    failures = missing_engineering_files()
    if arguments.public:
        failures.extend(public_release_failures())
        if not any((ROOT / path).is_file() for path in LICENSE_FILES):
            failures.append("LICENSE: add an OSI-compatible project license")
    if failures:
        print("release-readiness blockers:")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1
    mode = "public" if arguments.public else "engineering"
    print(f"{mode} release readiness: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
