from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import trading_max.source_checkout as source_checkout
from trading_max.source_checkout import inspect_source_checkout


@pytest.mark.parametrize(
    ("remote", "expected"),
    [
        ("https://github.com/engramai-co/trading-max.git", "engramai-co/trading-max"),
        ("https://github.com/engramai-co/trading-max.git/", "engramai-co/trading-max"),
        ("git@github.com:engramai-co/trading-max.git", "engramai-co/trading-max"),
        ("ssh://git@github.com/engramai-co/trading-max.git", "engramai-co/trading-max"),
        ("https://[invalid-secret-host", None),
        ("file://github.com/engramai-co/trading-max.git", None),
        ("https://github.com.example/engramai-co/trading-max.git", None),
    ],
)
def test_source_remote_parsing_accepts_github_transports_and_handles_malformed_urls(
    remote: str,
    expected: str | None,
) -> None:
    assert source_checkout._repository_slug(remote) == expected


def test_source_commands_disable_optional_git_writes_and_bound_their_runtime(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls = []

    def fake_run(arguments, **options):
        calls.append((arguments, options))
        return subprocess.CompletedProcess(arguments, 0, "fixture\n", "")

    monkeypatch.setattr(source_checkout.shutil, "which", lambda _name: "/synthetic/git")
    monkeypatch.setattr(source_checkout.subprocess, "run", fake_run)

    assert source_checkout._git(tmp_path, "status", "--porcelain") == "fixture"
    assert "--no-optional-locks" in calls[0][0]
    assert calls[0][1]["timeout"] == 30


def test_source_command_timeout_is_reported_without_remote_details(
    tmp_path: Path, monkeypatch
) -> None:
    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(["synthetic-secret-remote"], 30)

    monkeypatch.setattr(source_checkout.shutil, "which", lambda _name: "/synthetic/git")
    monkeypatch.setattr(source_checkout.subprocess, "run", timeout)

    with pytest.raises(source_checkout.SourceCheckoutError) as error:
        source_checkout._git(tmp_path, "ls-remote", "origin", "refs/heads/main")
    assert "synthetic-secret" not in str(error.value)


def test_canonical_main_rejects_non_hexadecimal_commit_identifiers(
    tmp_path: Path, monkeypatch
) -> None:
    source = source_checkout.SourceCheckout(tmp_path, "a" * 40, "main", False, "origin")
    monkeypatch.setattr(source_checkout, "_git", lambda *_args: f"{'z' * 40}\trefs/heads/main")

    with pytest.raises(source_checkout.SourceCheckoutError, match="unexpected Git reference"):
        source_checkout.canonical_main_sha(source)


def test_source_provenance_requires_origin_or_upstream(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / ".git").mkdir()

    def fake_git(_root: Path, *arguments: str) -> str:
        if arguments == ("remote",):
            return "mirror\norigin\nupstream"
        if arguments[:2] == ("remote", "get-url"):
            return (
                "https://github.com/engramai-co/trading-max.git"
                if arguments[2] == "mirror"
                else "https://github.com/example/fork.git"
            )
        if arguments == ("rev-parse", "HEAD"):
            return "a" * 40
        if arguments == ("branch", "--show-current"):
            return "main"
        return ""

    monkeypatch.setattr(source_checkout, "_git", fake_git)

    assert inspect_source_checkout(tmp_path).canonical_remote is None


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
