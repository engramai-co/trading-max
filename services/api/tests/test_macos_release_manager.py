"""Exercise cutover failures using real retained directories and state files."""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from trading_max.infrastructure import SqliteDatabase

SCRIPT = Path(__file__).resolve().parents[3] / "deploy/macos/release-manager.py"
spec = importlib.util.spec_from_file_location("release_manager", SCRIPT)
assert spec and spec.loader
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


def test_model_rollback_preserves_business_writes_and_broker_settings(tmp_path):
    migrations = SCRIPT.parents[2] / "backend/migrations"
    previous_migrations = tmp_path / "old-migrations"
    previous_migrations.mkdir()
    for source in migrations.glob("*.sql"):
        if source.name < "0019":
            shutil.copyfile(source, previous_migrations / source.name)
    database = tmp_path / "trading_max.db"
    SqliteDatabase(database, previous_migrations).close()
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE llm_route_policy SET default_route='deepseek/deepseek-v4-flash'")
        for provider in ("deepseek", "trading212"):
            connection.execute(
                "INSERT INTO integration_settings (integration_id,provider,enabled,updated_at) "
                "VALUES (?,?,1,'before')",
                (provider + ":default", provider),
            )
        connection.execute("CREATE TABLE synthetic_account_records (value INTEGER)")
        connection.execute("INSERT INTO synthetic_account_records VALUES (100)")
    snapshot = tmp_path / "previous-models.json"
    manager.capture_llm_settings(database, snapshot)
    assert snapshot.stat().st_mode & 0o777 == 0o600
    assert "trading212" not in snapshot.read_text()
    SqliteDatabase(database, migrations).close()
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE llm_route_policy SET default_route='openai-codex/gpt-5.6-luna'")
        connection.execute(
            "INSERT INTO integration_settings (integration_id,provider,enabled,updated_at) "
            "VALUES ('openai-codex:default','openai-codex',1,'after')"
        )
        connection.execute("UPDATE integration_settings SET revision=2 WHERE provider='trading212'")
        connection.execute("INSERT INTO synthetic_account_records VALUES (200)")
    manager.restore_llm_settings(database, snapshot)
    # The previous runtime's migration runner can reopen the upgraded database.
    old = SqliteDatabase(database, previous_migrations)
    with old.read() as connection:
        assert (
            connection.execute("SELECT default_route FROM llm_route_policy").fetchone()[0]
            == "deepseek/deepseek-v4-flash"
        )
        assert (
            connection.execute(
                "SELECT enabled FROM integration_settings WHERE provider='deepseek'"
            ).fetchone()[0]
            == 1
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM integration_settings WHERE provider='openai-codex'"
            ).fetchone()[0]
            == 0
        )
        assert (
            connection.execute(
                "SELECT revision FROM integration_settings WHERE provider='trading212'"
            ).fetchone()[0]
            == 2
        )
        assert (
            connection.execute("SELECT sum(value) FROM synthetic_account_records").fetchone()[0]
            == 300
        )
    old.close()


def test_invalid_model_restore_is_transactional(tmp_path):
    database = tmp_path / "trading_max.db"
    SqliteDatabase(database).close()
    with sqlite3.connect(database) as connection:
        before = connection.execute("SELECT * FROM llm_route_policy").fetchall()
    snapshot = tmp_path / "invalid.json"
    snapshot.write_text(json.dumps({"integrations": [], "routes": [{"unknown": "invalid"}]}))
    with pytest.raises(RuntimeError, match="incompatible"):
        manager.restore_llm_settings(database, snapshot)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM llm_route_policy").fetchall() == before


def test_shared_node_is_immutable_independent_of_source_and_survives_retired_release(tmp_path):
    source = tmp_path / "source-node"
    source.write_text("#!/bin/sh\nprintf 'v22.22.2\\n'\n")
    source.chmod(0o755)
    shared = tmp_path / "toolchains/node-blobs"
    releases = [tmp_path / name for name in ("one", "two")]
    for release in releases:
        release.mkdir()
    first, second = [
        manager.pin_node_runtime(release, str(source), shared=shared) for release in releases
    ]
    assert first.stat().st_ino == second.stat().st_ino
    assert first.stat().st_ino != source.stat().st_ino
    assert not first.stat().st_mode & 0o222
    original = first.read_bytes()
    source.write_text("external source changed")
    first.unlink()
    assert second.read_bytes() == original
    assert next(shared.iterdir()).stat().st_nlink == 2


def test_shared_node_rejects_tampering_before_reuse(tmp_path):
    source = tmp_path / "source-node"
    source.write_text("#!/bin/sh\nprintf 'v22.22.2\\n'\n")
    source.chmod(0o755)
    shared = tmp_path / "toolchains/node-blobs"
    first = tmp_path / "first"
    first.mkdir()
    manager.pin_node_runtime(first, str(source), shared=shared)
    blob = next(shared.iterdir())
    blob.chmod(0o755)
    blob.write_text("tampered")
    second = tmp_path / "second"
    second.mkdir()
    with pytest.raises(RuntimeError, match="corrupt or writable"):
        manager.pin_node_runtime(second, str(source), shared=shared)
    assert not (second / ".node-runtime/node").exists()


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

    def capture_models(self) -> None:
        assert not self.running
        self.check("capture-models")

    def backup(self) -> None:
        assert self.running
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
        "capture-models",
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
        "failed-before-cutover" if failure in {"build", "capture", "backup"} else "rolled-back"
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
    assert host.events.index("backup") < host.events.index("stop")
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


def test_deployment_prefers_retained_node_over_changed_host_path(tmp_path: Path, monkeypatch):
    retained = tmp_path / "active/.node-runtime/node"
    retained.parent.mkdir(parents=True)
    retained.write_text('#!/bin/sh\nprintf "v22.22.2\\n"\n')
    retained.chmod(0o700)
    host = tmp_path / "host-node"
    host.write_text('#!/bin/sh\nprintf "v25.8.2\\n"\n')
    host.chmod(0o700)
    monkeypatch.setattr(manager.shutil, "which", lambda _: str(host))
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    pinned = manager.pin_node_runtime(candidate, manager.node_source(tmp_path / "active"))
    assert "v22.22.2" in pinned.read_text()
    assert manager.node_source(tmp_path / "active", str(host)) == str(host)
    with pytest.raises(RuntimeError, match=r"Node\.js 22"):
        manager.pin_node_runtime(tmp_path, manager.node_source(tmp_path / "active", str(host)))


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


@pytest.mark.parametrize("eventually_ready", [False, True])
def test_health_waits_for_ready_json_even_when_http_status_is_200(
    tmp_path: Path, monkeypatch, eventually_ready: bool
):
    host = SimulatedHost(tmp_path)
    urls = []
    sleeps = []

    class Response(io.BytesIO):
        status = 200

    def response(url: str, *, timeout: int):
        urls.append(url)
        ready = eventually_ready and len(urls) > 1
        return Response(json.dumps({"status": "ready" if ready else "not_ready"}).encode())

    monkeypatch.setattr(manager, "urlopen", response)
    monkeypatch.setattr(manager.time, "sleep", sleeps.append)
    monkeypatch.setattr(
        host, "run", lambda *args, **kwargs: SimpleNamespace(stdout="state = running")
    )
    if eventually_ready:
        manager.Deployment.health(host)
        assert urls == [
            "http://127.0.0.1:8421/ready",
            "http://127.0.0.1:8421/ready",
            "http://127.0.0.1:3413/",
        ]
        assert sleeps == [2]
    else:
        with pytest.raises(RuntimeError, match="readiness failed"):
            manager.Deployment.health(host)
        assert urls == ["http://127.0.0.1:8421/ready"] * 30
        assert len(sleeps) == 30


def standalone_fixture(tmp_path):
    web = tmp_path / "apps/web"
    standalone = web / ".next/standalone"
    for name in (
        "server.js",
        "node_modules/next/package.json",
        ".next/BUILD_ID",
        ".next/static/a.js",
        "public/logo.svg",
    ):
        path = standalone / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic runtime")
    for name in ("node_modules/build-only/data", ".next/cache/compiler", ".next/BUILD_ID"):
        path = web / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic build")
    return web, standalone


def test_trim_retains_complete_standalone_and_build_identity(tmp_path):
    web, standalone = standalone_fixture(tmp_path)
    expected = {
        p.relative_to(standalone): p.read_bytes() for p in standalone.rglob("*") if p.is_file()
    }
    manager.trim_build_dependencies(tmp_path)
    assert not (web / "node_modules").exists()
    assert not (web / ".next/cache").exists()
    assert (web / ".next/BUILD_ID").is_file()
    assert {
        p.relative_to(standalone): p.read_bytes() for p in standalone.rglob("*") if p.is_file()
    } == expected


@pytest.mark.parametrize("failure", ["missing", "external-link"])
def test_trim_refuses_incomplete_or_external_runtime_before_removing_anything(tmp_path, failure):
    web, standalone = standalone_fixture(tmp_path)
    if failure == "missing":
        (standalone / "server.js").unlink()
    else:
        (standalone / "build-link").symlink_to(web / "node_modules", target_is_directory=True)
    with pytest.raises(RuntimeError, match="standalone"):
        manager.trim_build_dependencies(tmp_path)
    assert (web / "node_modules/build-only/data").is_file()
    assert (web / ".next/cache/compiler").is_file()
