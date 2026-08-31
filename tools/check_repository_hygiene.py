"""Reject generated/runtime material in newly productized repository areas."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_ROOTS = (
    ".github/",
    "backend/",
    "services/",
    "apps/",
    "contracts/",
    "deploy/",
)
BLOCKED_COMPONENTS = {
    "runtime",
    "data",
    "outputs",
    "tmp",
    "cache",
    "snapshots",
    "generated",
    "logs",
}
BLOCKED_NAMES = {
    ".env",
    ".env.local",
    "config.local.json",
    "credentials.json",
    "secrets.json",
}
PRIVATE_DOCUMENT_ROOTS = (
    ".impeccable/critique/",
    ".impeccable/live/",
    "docs/handoffs/",
)
HARDCODED_HOME_MARKERS = ("/Users/", "/home/")
PRIVATE_MARKERS = (".ts.net",)
BLOCKED_BINARY_SUFFIXES = {
    ".csv",
    ".db",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".sqlite",
    ".sqlite3",
}
ALLOWED_PUBLIC_BINARY_PREFIXES = ("apps/web/public/brand/",)
ALLOWED_REFERENCE_DATA_PREFIXES = ("backend/src/trading_max/reference/data/",)


def is_versioned_reference_data(path: str) -> bool:
    """Return whether a tracked JSON file is packaged, read-only reference data."""
    return Path(path).suffix.lower() == ".json" and path.startswith(ALLOWED_REFERENCE_DATA_PREFIXES)


def tracked_files() -> list[str]:
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git executable is required for repository hygiene checks")
    result = subprocess.run(  # noqa: S603 - executable resolved from trusted PATH
        [git, "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [path for path in result.stdout.decode().split("\0") if path]


def violations() -> list[str]:
    found: list[str] = []
    for path in tracked_files():
        parts = Path(path).parts
        if path.startswith(PRIVATE_DOCUMENT_ROOTS):
            found.append(f"{path}: private working document")
            continue
        if any(
            component in BLOCKED_COMPONENTS for component in parts
        ) and not is_versioned_reference_data(path):
            found.append(path)
            continue
        if Path(path).name in BLOCKED_NAMES:
            found.append(path)
            continue
        if Path(path).suffix.lower() in BLOCKED_BINARY_SUFFIXES and not path.startswith(
            ALLOWED_PUBLIC_BINARY_PREFIXES
        ):
            found.append(f"{path}: blocked binary/data artifact")
            continue
        try:
            content = (ROOT / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if path in {
            "tools/check_public_history.py",
            "tools/check_repository_hygiene.py",
        }:
            continue
        if any(marker in content for marker in HARDCODED_HOME_MARKERS):
            found.append(f"{path}: hardcoded user-home path")
        if any(marker in content for marker in PRIVATE_MARKERS):
            found.append(f"{path}: private host/network marker")
    return sorted(found)


def main() -> int:
    found = violations()
    if found:
        print("repository hygiene violations:")
        print("\n".join(f"- {path}" for path in found))
        return 1
    print("repository hygiene: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
