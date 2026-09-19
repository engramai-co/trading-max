from __future__ import annotations

import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DEPLOY_SCRIPT = ROOT / "deploy" / "macos" / "deploy.sh"
PRODUCTION_SMOKE_SCRIPT = ROOT / "deploy" / "macos" / "production-smoke.sh"
GIT = shutil.which("git")
if GIT is None:  # pragma: no cover - Git is a repository test prerequisite.
    raise RuntimeError("git executable is required")


def _git(*arguments: str, cwd: Path) -> str:
    return subprocess.run(
        [GIT, *arguments],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def deployment_checkout(tmp_path: Path) -> tuple[Path, str, str]:
    remote = tmp_path / "remote.git"
    source = tmp_path / "source"
    checkout = tmp_path / "service" / "app"
    remote.mkdir()
    source.mkdir()
    _git("init", "--bare", cwd=remote)
    _git("init", "-b", "main", cwd=source)
    _git("config", "user.email", "ci@example.invalid", cwd=source)
    _git("config", "user.name", "CI", cwd=source)
    (source / "README.md").write_text("trusted\n", encoding="utf-8")
    _git("add", "README.md", cwd=source)
    _git("commit", "-m", "trusted", cwd=source)
    _git("remote", "add", "origin", str(remote), cwd=source)
    _git("push", "-u", "origin", "main", cwd=source)
    _git("clone", "--branch", "main", str(remote), str(checkout), cwd=tmp_path)
    _git("config", "user.email", "ci@example.invalid", cwd=checkout)
    _git("config", "user.name", "CI", cwd=checkout)
    (checkout / "UNREVIEWED.md").write_text("untrusted\n", encoding="utf-8")
    _git("add", "UNREVIEWED.md", cwd=checkout)
    _git("commit", "-m", "untrusted", cwd=checkout)
    untrusted = _git("rev-parse", "HEAD", cwd=checkout)
    (source / "README.md").write_text("trusted\nupdated\n", encoding="utf-8")
    _git("add", "README.md", cwd=source)
    _git("commit", "-m", "trusted update", cwd=source)
    trusted = _git("rev-parse", "HEAD", cwd=source)
    _git("push", "origin", "main", cwd=source)
    return checkout, trusted, untrusted


def _run_deploy_validation(checkout: Path, target: str) -> subprocess.CompletedProcess[str]:
    zsh = shutil.which("zsh")
    if zsh is None:
        pytest.skip("zsh is required to exercise the macOS deploy contract")
    environment = {
        **os.environ,
        "TRADING_MAX_APP_ROOT": str(checkout),
        "TRADING_MAX_DEPLOY_VALIDATE_ONLY": "true",
    }
    return subprocess.run(
        [zsh, str(DEPLOY_SCRIPT), target],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_deploy_rejects_non_sha_target(tmp_path: Path) -> None:
    checkout = tmp_path / "app"
    checkout.mkdir()
    result = _run_deploy_validation(checkout, "main")
    assert result.returncode == 64
    assert "full lowercase 40-character commit SHA" in result.stderr


def test_deploy_accepts_only_commits_reachable_from_main(
    deployment_checkout: tuple[Path, str, str],
) -> None:
    checkout, trusted, untrusted = deployment_checkout

    accepted = _run_deploy_validation(checkout, trusted)
    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    assert "validation-only deployment contract passed" in accepted.stdout

    rejected = _run_deploy_validation(checkout, untrusted)
    assert rejected.returncode == 65
    assert "is not reachable from origin/main" in rejected.stdout


def test_production_smoke_checks_dynamic_web_routes() -> None:
    script = PRODUCTION_SMOKE_SCRIPT.read_text(encoding="utf-8")

    assert 'for route in "/" "/health" "/analytics"' in script
    assert '"/health"' in script
    assert '"/analytics"' in script


@pytest.mark.parametrize("retain", ["0", "-1", "invalid"])
def test_backup_rejects_invalid_retention_before_creating_archive(tmp_path: Path, retain: str):
    zsh = shutil.which("zsh")
    if zsh is None:
        pytest.skip("zsh is required to exercise the macOS backup contract")
    destination = tmp_path / "backups"
    result = subprocess.run(
        [zsh, str(ROOT / "deploy/macos/backup.sh"), str(destination)],
        env={
            **os.environ,
            "TRADING_MAX_BACKUP_RETAIN": retain,
            "TRADING_MAX_STATE_ROOT": str(tmp_path / "state"),
            "TRADING_MAX_SERVICE_ROOT": str(tmp_path / "service"),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 64
    assert "positive integer" in result.stderr
    assert not destination.exists()


def test_backup_rejects_destination_inside_state_root(tmp_path: Path):
    zsh = shutil.which("zsh")
    if zsh is None:
        pytest.skip("zsh is required to exercise the macOS backup contract")
    service = tmp_path / "service"
    binary = service / "app/.venv/bin/python"
    binary.parent.mkdir(parents=True)
    binary.symlink_to(sys.executable)
    state = tmp_path / "state"
    state.mkdir()
    destination = state / "backups"
    result = subprocess.run(
        [zsh, str(ROOT / "deploy/macos/backup.sh"), str(destination)],
        env={
            **os.environ,
            "TRADING_MAX_STATE_ROOT": str(state),
            "TRADING_MAX_SERVICE_ROOT": str(service),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "outside the state root" in result.stderr
    assert not destination.exists()


def test_macos_backup_excludes_environment_variants_and_is_private(tmp_path: Path):
    zsh = shutil.which("zsh")
    if zsh is None:
        pytest.skip("zsh is required to exercise the macOS backup contract")
    service = tmp_path / "service"
    binary = service / "app/.venv/bin/python"
    binary.parent.mkdir(parents=True)
    binary.symlink_to(sys.executable)
    validator = service / "app/tools/verify_backup_archive.py"
    validator.parent.mkdir()
    shutil.copy2(ROOT / "tools/verify_backup_archive.py", validator)
    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as connection:
        connection.execute("CREATE TABLE fixture (value TEXT)")
    (state / "watchlist.json").write_text("{}")
    for name in (".env.local", ".env.bak", "bootstrap.env.bak"):
        (state / name).write_text("SYNTHETIC_SECRET=exclude-me")
    destination = tmp_path / "backups"
    result = subprocess.run(
        [zsh, str(ROOT / "deploy/macos/backup.sh"), str(destination)],
        env={
            **os.environ,
            "TRADING_MAX_STATE_ROOT": str(state),
            "TRADING_MAX_SERVICE_ROOT": str(service),
            "TRADING_MAX_BACKUP_RETAIN": "14",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    (archive,) = destination.glob("trading_max-*.tar.gz")
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    with tarfile.open(archive, "r:gz") as handle:
        names = handle.getnames()
    assert "state/./watchlist.json" in names or "state/watchlist.json" in names
    assert not any(".env" in name for name in names)
