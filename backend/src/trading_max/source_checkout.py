"""Read-only source provenance checks for local Trading Max installations."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

CANONICAL_REPOSITORY = "engramai-co/trading-max"
CANONICAL_REPOSITORY_URL = f"https://github.com/{CANONICAL_REPOSITORY}.git"


class SourceCheckoutError(RuntimeError):
    """A source checkout cannot be inspected without exposing remote details."""


@dataclass(frozen=True, slots=True)
class SourceCheckout:
    root: Path
    commit: str
    branch: str
    dirty: bool
    canonical_remote: str | None


def _repository_slug(remote_url: str) -> str | None:
    """Return an owner/repository slug without retaining credentials or hosts."""

    value = remote_url.strip()
    if value.startswith("git@github.com:"):
        path = value.removeprefix("git@github.com:")
    else:
        parsed = urlsplit(value)
        if parsed.hostname != "github.com":
            return None
        path = parsed.path.lstrip("/")
    return path.removesuffix(".git").rstrip("/") or None


def _git(root: Path, *arguments: str) -> str:
    executable = shutil.which("git")
    if executable is None:
        raise SourceCheckoutError("git is required to inspect source provenance")
    try:
        result = subprocess.run(  # noqa: S603 - resolved executable and bounded argv
            [executable, *arguments],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SourceCheckoutError("could not inspect the Git checkout") from exc
    return result.stdout.strip()


def inspect_source_checkout(app_root: Path) -> SourceCheckout:
    """Inspect local Git identity without printing arbitrary remote URLs."""

    root = app_root.expanduser().resolve()
    if not (root / ".git").exists():
        raise SourceCheckoutError(f"not a Git checkout: {root}")
    remotes = _git(root, "remote").splitlines()
    canonical_remote: str | None = None
    for remote in remotes:
        try:
            slug = _repository_slug(_git(root, "remote", "get-url", remote))
        except SourceCheckoutError:
            continue
        if slug == CANONICAL_REPOSITORY and canonical_remote is None:
            canonical_remote = remote
    return SourceCheckout(
        root=root,
        commit=_git(root, "rev-parse", "HEAD"),
        branch=_git(root, "branch", "--show-current") or "detached",
        dirty=bool(_git(root, "status", "--porcelain")),
        canonical_remote=canonical_remote,
    )


def canonical_main_sha(checkout: SourceCheckout) -> str:
    """Read protected public main from GitHub without changing the checkout."""

    if checkout.canonical_remote is None:
        raise SourceCheckoutError(
            f"no remote points to the canonical {CANONICAL_REPOSITORY} repository"
        )
    output = _git(
        checkout.root,
        "ls-remote",
        "--exit-code",
        checkout.canonical_remote,
        "refs/heads/main",
    )
    sha, _separator, reference = output.partition("\t")
    if len(sha) != 40 or reference != "refs/heads/main":
        raise SourceCheckoutError("canonical main returned an unexpected Git reference")
    return sha


__all__ = [
    "CANONICAL_REPOSITORY",
    "CANONICAL_REPOSITORY_URL",
    "SourceCheckout",
    "SourceCheckoutError",
    "canonical_main_sha",
    "inspect_source_checkout",
]
