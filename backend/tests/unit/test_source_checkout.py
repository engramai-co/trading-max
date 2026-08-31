from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from trading_max.source_checkout import inspect_source_checkout


def _git(root: Path, *arguments: str) -> None:
    executable = shutil.which("git")
    assert executable is not None
    subprocess.run(  # noqa: S603 - resolved test executable and fixture argv
        [executable, *arguments],
        cwd=root,
        check=True,
        capture_output=True,
    )


def test_source_checkout_accepts_canonical_upstream(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    _git(checkout, "init", "-b", "main")
    _git(checkout, "config", "user.name", "Test")
    _git(checkout, "config", "user.email", "test@example.com")
    (checkout / "README.md").write_text("fixture\n", encoding="utf-8")
    _git(checkout, "add", "README.md")
    _git(checkout, "commit", "-m", "fixture")
    _git(checkout, "remote", "add", "origin", "https://github.com/example/fork.git")
    _git(
        checkout,
        "remote",
        "add",
        "upstream",
        "git@github.com:engramai-co/trading-max.git",
    )
    source = inspect_source_checkout(checkout)

    assert source.canonical_remote == "upstream"
    assert source.branch == "main"
    assert source.dirty is False
