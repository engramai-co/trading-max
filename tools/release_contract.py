"""Shared helpers for Trading Max's version and changelog release contract."""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
CHANGELOG_HEADING_RE = re.compile(
    r"^## \[(?P<version>[^\]]+)\](?:\s*-\s*(?P<date>\d{4}-\d{2}-\d{2}))?\s*$",
    re.MULTILINE,
)
CHANGELOG_SUBSECTION_RE = re.compile(
    r"^### (?:Added|Changed|Fixed|Removed|Deprecated|Security)\s*$",
    re.MULTILINE,
)
CHANGELOG_BULLET_RE = re.compile(r"^\s*[-*]\s+\S", re.MULTILINE)


class ReleaseContractError(ValueError):
    """Raised when a release artifact violates the repository contract."""


@dataclass(frozen=True)
class ChangelogRelease:
    version: str
    released_on: str
    body: str


def parse_semver(value: str) -> tuple[int, int, int]:
    """Parse a strict three-part SemVer value without prefixes or metadata."""
    match = SEMVER_RE.fullmatch(value.strip())
    if match is None:
        raise ReleaseContractError(
            f"version must use MAJOR.MINOR.PATCH without a prefix: {value!r}"
        )
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def validate_version_increment(base_value: str, head_value: str) -> None:
    """Require exactly one conventional patch, minor, or major increment."""
    base = parse_semver(base_value)
    head = parse_semver(head_value)
    allowed = {
        (base[0], base[1], base[2] + 1),
        (base[0], base[1] + 1, 0),
        (base[0] + 1, 0, 0),
    }
    if head not in allowed:
        allowed_text = ", ".join(".".join(map(str, version)) for version in sorted(allowed))
        raise ReleaseContractError(
            f"VERSION must advance exactly once from {base_value}; expected one of "
            f"{allowed_text}, got {head_value}"
        )


def validate_initial_version(head_value: str) -> None:
    """Require the repository's one-time public release baseline to be 1.0.0."""
    if parse_semver(head_value) != (1, 0, 0):
        raise ReleaseContractError(f"the first VERSION baseline must be 1.0.0, got {head_value}")


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def project_versions(root: Path = ROOT) -> dict[str, str]:
    """Read every version surface shipped by the Python/TypeScript monorepo."""
    root_pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    backend_pyproject = tomllib.loads(
        (root / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    )
    root_package = _read_json(root / "package.json")
    web_package = _read_json(root / "apps" / "web" / "package.json")
    web_lock = _read_json(root / "apps" / "web" / "package-lock.json")
    openapi = _read_json(root / "contracts" / "openapi.json")
    uv_lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    init_text = (root / "backend" / "src" / "trading_max" / "__init__.py").read_text(
        encoding="utf-8"
    )
    init_match = re.search(r'__version__\s*=\s*"([^"]+)"', init_text)
    if init_match is None:
        raise ReleaseContractError("backend package version is missing")

    web_lock_packages = web_lock.get("packages")
    if not isinstance(web_lock_packages, dict) or not isinstance(web_lock_packages.get(""), dict):
        raise ReleaseContractError("web package lock is missing its root package")
    uv_packages = {
        package.get("name"): package.get("version")
        for package in uv_lock.get("package", [])
        if isinstance(package, dict)
    }

    return {
        "VERSION": (root / "VERSION").read_text(encoding="utf-8").strip(),
        "root pyproject": str(root_pyproject["project"]["version"]),
        "backend pyproject": str(backend_pyproject["project"]["version"]),
        "root package": str(root_package["version"]),
        "web package": str(web_package["version"]),
        "web lock": str(web_lock["version"]),
        "web lock root package": str(web_lock_packages[""]["version"]),
        "backend package": init_match.group(1),
        "OpenAPI": str(openapi["info"]["version"]),
        "uv lock root package": str(uv_packages.get("trading-max")),
        "uv lock backend package": str(uv_packages.get("trading-max-backend")),
    }


def validate_project_versions(expected: str, root: Path = ROOT) -> dict[str, str]:
    """Return all surfaces after asserting they equal the expected version."""
    parse_semver(expected)
    versions = project_versions(root)
    mismatches = {surface: value for surface, value in versions.items() if value != expected}
    if mismatches:
        detail = "\n".join(f"- {surface}: {value}" for surface, value in mismatches.items())
        raise ReleaseContractError(
            f"expected version {expected} on every shipped surface:\n{detail}"
        )
    return versions


def find_changelog_release(text: str, expected_version: str) -> ChangelogRelease:
    """Validate and return the top formal changelog release."""
    matches = list(CHANGELOG_HEADING_RE.finditer(text))
    release_match = next(
        (match for match in matches if match.group("version").lower() != "unreleased"),
        None,
    )
    if release_match is None:
        raise ReleaseContractError("CHANGELOG has no formal release section")
    version = release_match.group("version")
    released_on = release_match.group("date")
    if version != expected_version:
        raise ReleaseContractError(
            f"top CHANGELOG release is [{version}], expected [{expected_version}]"
        )
    if released_on is None:
        raise ReleaseContractError(f"CHANGELOG release [{version}] must include a YYYY-MM-DD date")
    try:
        date.fromisoformat(released_on)
    except ValueError as error:
        raise ReleaseContractError(
            f"CHANGELOG release [{version}] has an invalid date: {released_on}"
        ) from error

    next_match = next(
        (match for match in matches if match.start() > release_match.start()),
        None,
    )
    body_end = next_match.start() if next_match else len(text)
    body = text[release_match.end() : body_end].strip()
    if CHANGELOG_SUBSECTION_RE.search(body) is None:
        raise ReleaseContractError(
            f"CHANGELOG release [{version}] needs an Added/Changed/Fixed-style subsection"
        )
    if CHANGELOG_BULLET_RE.search(body) is None:
        raise ReleaseContractError(f"CHANGELOG release [{version}] needs at least one bullet")
    return ChangelogRelease(version=version, released_on=released_on, body=body)


def extract_release_notes(text: str, version: str) -> str:
    """Extract a validated release body for an exact changelog version."""
    matches = list(CHANGELOG_HEADING_RE.finditer(text))
    target = next((match for match in matches if match.group("version") == version), None)
    if target is None:
        raise ReleaseContractError(f"CHANGELOG release [{version}] was not found")
    next_match = next((match for match in matches if match.start() > target.start()), None)
    body_end = next_match.start() if next_match else len(text)
    body = text[target.end() : body_end].strip()
    if not body:
        raise ReleaseContractError(f"CHANGELOG release [{version}] has no notes")
    return f"{body}\n"
