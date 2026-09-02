"""Reject private artifacts and personal identities from a publishable Git history."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
GIT = shutil.which("git")
if GIT is None:
    raise RuntimeError("git executable is required")
ALLOWED_BINARY_PREFIXES = (
    "apps/web/public/brand/",
    "docs/assets/",
)
ALLOWED_DATA_PREFIXES = ("backend/src/trading_max/reference/data/",)
BLOCKED_ROOTS = (".impeccable/critique/", ".impeccable/live/", "docs/handoffs/")
BLOCKED_COMPONENTS = {
    "backups",
    "cache",
    "data",
    "generated",
    "logs",
    "outputs",
    "runtime",
    "snapshots",
    "tmp",
}
BLOCKED_SUFFIXES = {
    ".csv",
    ".db",
    ".gz",
    ".jpeg",
    ".jpg",
    ".ndjson",
    ".pdf",
    ".png",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".webp",
    ".xls",
    ".xlsx",
    ".zip",
}
PUBLIC_AUTHOR_DOMAINS = {
    "engramai.co",
    "github.com",
    "users.noreply.github.com",
}
PRIVATE_CONTENT_PATTERN = re.compile(
    r"/Users/[A-Za-z0-9._-]+/|"
    r"/home/[A-Za-z0-9._-]+/|"
    r"\.ts\.net|"
    r"tail[0-9]{6}|"
    r"eu_prod_|"
    r"[A-Z0-9._%+-]+@(gmail|hotmail|icloud|outlook)\.com",
    re.IGNORECASE,
)
CONTENT_SCAN_EXCLUDES = (
    ":(exclude)tools/check_public_history.py",
    ":(exclude)tools/check_repository_hygiene.py",
)


def git(*arguments: str, check: bool = True) -> str:
    result = subprocess.run(  # noqa: S603 - executable and arguments are fixed by this tool
        [GIT, *arguments],
        cwd=ROOT,
        check=check,
        capture_output=True,
        text=True,
    )
    return result.stdout


def historical_paths() -> set[str]:
    output = git("log", "--all", "--name-only", "--pretty=format:")
    return {line.strip() for line in output.splitlines() if line.strip()}


def path_violations() -> list[str]:
    failures: list[str] = []
    for path in sorted(historical_paths()):
        if path == ".env.example":
            continue
        if path == ".env" or path.startswith(".env.") or "/.env" in path:
            failures.append(f"{path}: environment file exists in history")
            continue
        if path.startswith(BLOCKED_ROOTS):
            failures.append(f"{path}: private legacy research exists in history")
            continue
        if path.startswith(ALLOWED_DATA_PREFIXES):
            continue
        if any(component in BLOCKED_COMPONENTS for component in PurePosixPath(path).parts):
            failures.append(f"{path}: runtime or generated material exists in history")
            continue
        if PurePosixPath(path).suffix.lower() in BLOCKED_SUFFIXES and not path.startswith(
            ALLOWED_BINARY_PREFIXES
        ):
            failures.append(f"{path}: binary or data artifact exists in history")
    return failures


def author_violations() -> list[str]:
    counts: dict[str, int] = {}
    output = git("log", "--all", "--format=%ae")
    for email in output.splitlines():
        domain = email.rsplit("@", 1)[-1].lower() if "@" in email else "missing"
        if domain not in PUBLIC_AUTHOR_DOMAINS:
            counts[domain] = counts.get(domain, 0) + 1
    return [
        f"history: {count} commit(s) use non-public author domain {domain!r}"
        for domain, count in sorted(counts.items())
    ]


def content_violations() -> list[str]:
    patch_history = git(
        "log",
        "--all",
        "-p",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        ".",
        *CONTENT_SCAN_EXCLUDES,
    )
    if PRIVATE_CONTENT_PATTERN.search(patch_history):
        return ["history: personal host, path, email, network, or provider-key marker found"]
    return []


def main() -> int:
    failures = sorted(set(path_violations() + author_violations() + content_violations()))
    if failures:
        print("public-history blockers:")
        print("\n".join(f"- {failure}" for failure in failures[:120]))
        if len(failures) > 120:
            print(f"- ... {len(failures) - 120} additional blocker(s) omitted")
        print("Create a clean public export; do not switch this history to public.")
        return 1
    print("public history: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
