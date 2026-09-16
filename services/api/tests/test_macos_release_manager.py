"""Exercise cutover failures using real retained directories and state files."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "deploy/macos/release-manager.py"
spec = importlib.util.spec_from_file_location("release_manager", SCRIPT)
assert spec and spec.loader
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class SimulatedHost(manager.Deployment):
    def __init__(self, directory: Path, failure: str | None = None):
        service = directory / "service"
        app = service / "app"
        app.mkdir(parents=True)
        (app / "build").write_text("old installed runtime")
        state = directory / "state"
        (state / "secrets").mkdir(parents=True)
        (state / "secrets/trading_max.env").write_text("SYNTHETIC_SETTING=before\n")
        (state / "trading_max.db").write_text("existing data\n")
        super().__init__("a" * 40, service, app, state)
        self.failure = failure
        self.events: list[str] = []
        self.running = True

    def check(self, event: str) -> None:
        self.events.append(event)
        if event == self.failure:
            self.failure = None
            raise RuntimeError("simulated " + event)

    def build(self) -> None:
        # The active runtime stays complete while a new one is being built.
        assert (self.app / "build").read_text() == "old installed runtime"
        assert self.running
        (self.candidate / "build").write_text("new installed runtime")
        self.check("build")

    def capture_configuration(self) -> None:
        self.private.mkdir(parents=True)
        (self.private / "previous.env").write_bytes(self.env_file.read_bytes())
        self.started_services = list(manager.SERVICES)
        self.check("capture")

    def stop(self) -> None:
        self.running = False
        self.check("stop")

    def backup(self) -> None:
        assert not self.running
        self.check("backup")

    def activate(self) -> None:
        super().activate()
        self.check("activate")

    def configure(self) -> None:
        self.env_file.write_text("SYNTHETIC_SETTING=after\n")
        self.check("configure")

    def migrate(self) -> None:
        # Additive migrations / legitimate writes must not disappear when
        # deployment restores the old application and its dependencies.
        with (self.state / "trading_max.db").open("a") as stream:
            stream.write("compatible migration\n")
        self.check("migrate")

    def start(self, *, restore=False) -> None:
        self.running = True
        self.check("restore-services" if restore else "start")

    def health(self) -> None:
        assert self.running
        self.check("health")

    def smoke(self) -> None:
        self.check("smoke")


@pytest.mark.parametrize(
    "failure",
    [
        "build",
        "capture",
        "stop",
        "backup",
        "activate",
        "configure",
        "migrate",
        "start",
        "health",
        "smoke",
    ],
)
def test_failed_upgrade_restores_complete_runtime_without_rebuilding(tmp_path: Path, failure: str):
    host = SimulatedHost(tmp_path, failure)
    with pytest.raises(RuntimeError, match="simulated"):
        host.execute()
    assert host.running
    assert (host.app / "build").read_text() == "old installed runtime"
    assert host.env_file.read_text() == "SYNTHETIC_SETTING=before\n"
    assert host.events.count("build") == 1
    record = json.loads(host.record.read_text())
    assert record["phase"] == (
        "failed-before-cutover" if failure in {"build", "capture"} else "rolled-back"
    )
    if failure in {"migrate", "start", "health", "smoke"}:
        assert "compatible migration" in (host.state / "trading_max.db").read_text()


def test_success_retains_old_build_and_recovery_uses_it(tmp_path: Path):
    host = SimulatedHost(tmp_path)
    host.execute()
    assert host.app.is_symlink()
    assert host.app.resolve() == host.candidate
    assert (host.previous / "build").read_text() == "old installed runtime"
    assert json.loads(host.record.read_text())["phase"] == "healthy"
    host.rollback()
    assert host.app.resolve() == host.previous
    assert host.events.count("build") == 1
    assert "compatible migration" in (host.state / "trading_max.db").read_text()


def test_pointer_switch_does_not_relocate_previous_symlink_target(tmp_path: Path):
    old = tmp_path / "releases/old"
    new = tmp_path / "releases/new"
    old.mkdir(parents=True)
    new.mkdir()
    (old / "build").write_text("old")
    app = tmp_path / "app"
    app.symlink_to(old)
    manager.point_app(app, new)
    assert app.resolve() == new
    assert (old / "build").read_text() == "old"
    manager.point_app(app, old)
    assert (app / "build").read_text() == "old"


def test_missing_rollback_build_does_not_remove_active_pointer(tmp_path: Path):
    current = tmp_path / "current"
    current.mkdir()
    app = tmp_path / "app"
    app.symlink_to(current)
    with pytest.raises(FileNotFoundError):
        manager.point_app(app, tmp_path / "missing")
    assert app.resolve() == current


def test_interrupted_first_directory_conversion_recovers_missing_app_path(tmp_path: Path):
    host = SimulatedHost(tmp_path)

    def interrupted_activation():
        host.app.rename(host.previous)
        raise KeyboardInterrupt("interrupted before symlink")

    host.activate = interrupted_activation
    with pytest.raises(KeyboardInterrupt):
        host.execute()
    assert (host.app / "build").read_text() == "old installed runtime"
    assert host.running


def test_concurrent_deployment_is_rejected_before_building(tmp_path: Path, monkeypatch):
    service = tmp_path / "service"
    service.mkdir()
    monkeypatch.setenv("TRADING_MAX_SERVICE_ROOT", str(service))
    monkeypatch.setenv("TRADING_MAX_APP_ROOT", str(service / "app"))
    monkeypatch.setattr(sys, "argv", ["release-manager.py", "a" * 40])
    with (service / ".deployment.lock").open("a") as lock:
        manager.fcntl.flock(lock, manager.fcntl.LOCK_EX | manager.fcntl.LOCK_NB)
        with pytest.raises(SystemExit, match="another deployment"):
            manager.main()
    assert not (service / "releases").exists()


def test_node_runtime_is_retained_and_does_not_follow_host_replacement(tmp_path: Path):
    source = tmp_path / "host-node"
    source.write_text('#!/bin/sh\nprintf "v22.22.2\\n"\n')
    source.chmod(0o700)
    release = tmp_path / "release"
    release.mkdir()
    retained = manager.pin_node_runtime(release, str(source))
    source.write_text('#!/bin/sh\nprintf "v25.8.2\\n"\n')
    assert "v22.22.2" in retained.read_text()
    assert retained.stat().st_mode & 0o100
    with pytest.raises(RuntimeError, match=r"Node\.js 22 is required"):
        manager.pin_node_runtime(tmp_path, str(source))


def test_plist_path_expansion_preserves_xml_characters(tmp_path: Path):
    import plistlib

    original = {
        "ProgramArguments": ["__TRADING_MAX_HOME__/Services/trading-max/app/run.sh"],
        "KeepAlive": True,
    }
    service = tmp_path / "A & B"
    expanded = manager.expand_plist_paths(original, service, tmp_path)
    restored = plistlib.loads(plistlib.dumps(expanded))
    assert restored["ProgramArguments"] == [str(service / "app/run.sh")]
    assert restored["KeepAlive"] is True


def test_deployment_does_not_inherit_another_python_environment(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("VIRTUAL_ENV", "/synthetic/unrelated-venv")
    monkeypatch.setenv("PYTHONPATH", "/synthetic/unrelated-code")
    host = SimulatedHost(tmp_path)
    assert "VIRTUAL_ENV" not in host.environment
    assert "PYTHONPATH" not in host.environment
