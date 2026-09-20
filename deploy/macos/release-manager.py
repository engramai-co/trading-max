"""Build beside the active release; retain its complete runtime for rollback.

Invoked by deploy.sh after protected-main validation. Only deployment metadata,
release directories and the existing four service definitions are managed here.
Application-state rollback is deliberately separate from code rollback.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

SERVICES = ("api", "web", "worker", "backup")
LOGGER = logging.getLogger(__name__)


def pin_node_runtime(release: Path, source: str | None = None) -> Path:
    """Retain the supported executable used for both build and service runtime."""
    executable = Path(source or shutil.which("node") or "").resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("Node.js 22 is required; set TRADING_MAX_NODE_BINARY")
    version = subprocess.run(  # noqa: S603 - explicit local executable, no shell
        [str(executable), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if not re.fullmatch(r"v22\.\d+\.\d+", version):
        raise RuntimeError(f"Node.js 22 is required; found {version}")
    directory = release / ".node-runtime"
    directory.mkdir(mode=0o700)
    retained = directory / "node"
    shutil.copy2(executable, retained)
    return retained


def trim_build_dependencies(release: Path) -> None:
    """Keep a self-contained standalone server; discard only build-time outputs."""
    web = release / "apps/web"
    next_root = web / ".next"
    standalone = next_root / "standalone"
    required = (
        standalone / "server.js",
        standalone / "node_modules/next/package.json",
        standalone / ".next/BUILD_ID",
        standalone / ".next/static",
        standalone / "public",
    )
    if not all(path.exists() for path in required):
        raise RuntimeError("standalone runtime is incomplete; refusing to trim build dependencies")
    for root, directories, names in os.walk(standalone, followlinks=False):
        for name in directories + names:
            path = Path(root) / name
            if path.is_symlink() and not path.resolve().is_relative_to(standalone):
                raise RuntimeError("standalone runtime depends on an external build path")
    for path in [web / "node_modules", *next_root.iterdir()]:
        if path.name in {"standalone", "BUILD_ID"}:
            continue
        if path.is_symlink():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def expand_plist_paths(value, service: Path, home: Path):
    """Expand parsed values so XML-special characters in paths stay valid."""
    if isinstance(value, str):
        return value.replace("__TRADING_MAX_HOME__/Services/trading-max", str(service)).replace(
            "__TRADING_MAX_HOME__", str(home)
        )
    if isinstance(value, list):
        return [expand_plist_paths(item, service, home) for item in value]
    if isinstance(value, dict):
        return {key: expand_plist_paths(item, service, home) for key, item in value.items()}
    return value


def atomic_write(path: Path, content: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".deploy-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        Path(temporary).chmod(mode)
        Path(temporary).replace(path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def point_app(app: Path, release: Path) -> None:
    """Replace a symlink, never recursively copy over a running build."""
    if not release.is_dir():
        raise FileNotFoundError(f"retained release is missing: {release}")
    temporary = app.parent / (".app-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(release, target_is_directory=True)
        temporary.replace(app)
    finally:
        temporary.unlink(missing_ok=True)


class Deployment:
    def __init__(self, target: str, service: Path, app: Path, state: Path):
        self.target, self.service, self.app, self.state = target, service, app, state
        self.environment = {
            **os.environ,
            "TRADING_MAX_SERVICE_ROOT": str(service),
            "TRADING_MAX_APP_ROOT": str(app),
            "TRADING_MAX_STATE_ROOT": str(state),
            "NEXT_TELEMETRY_DISABLED": "1",
        }
        self.environment.pop("VIRTUAL_ENV", None)
        self.environment.pop("PYTHONPATH", None)
        self.uid = os.getuid()
        self.active = app.resolve(strict=True)
        self.releases = service / "releases"
        self.releases.mkdir(parents=True, exist_ok=True)
        self.candidate = Path(tempfile.mkdtemp(prefix=target[:12] + "-", dir=self.releases))
        self.transaction = self.candidate.name
        self.record = service / "deployments" / (self.transaction + ".json")
        self.private = state / "secrets" / "deployment-backups" / self.transaction
        self.env_file = state / "secrets" / "trading_max.env"
        self.agents = Path.home() / "Library" / "LaunchAgents"
        self.previous = (
            self.active if app.is_symlink() else self.releases / ("previous-" + self.transaction)
        )
        self.phase = "preparing"
        self.cutover_started = False
        self.started_services: list[str] = []
        self.backup_manifest: str | None = None

    def run(self, *args: str | Path, cwd: Path | None = None, capture=False, check=True):
        return subprocess.run(  # noqa: S603 - fixed commands, validated revisions, no shell
            [str(a) for a in args],
            cwd=cwd or self.service,
            env=self.environment,
            check=check,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )

    def save_record(self, phase: str) -> None:
        self.phase = phase
        atomic_write(
            self.record,
            (
                json.dumps(
                    {
                        "phase": phase,
                        "target": self.target,
                        "app": str(self.app),
                        "candidate": str(self.candidate),
                        "previous": str(self.previous),
                        "originalActive": str(self.active),
                        "state": str(self.state),
                        "privateBackup": str(self.private),
                        "loadedServices": self.started_services,
                        "backupManifest": getattr(self, "backup_manifest", None),
                    },
                    indent=2,
                )
                + "\n"
            ).encode(),
        )
        LOGGER.info("%s: %s", phase, self.target)

    def build(self) -> None:
        if self.run("git", "status", "--porcelain", cwd=self.active, capture=True).stdout.strip():
            raise RuntimeError("production checkout has local changes")
        self.run("git", "merge-base", "--is-ancestor", self.target, "origin/main", cwd=self.active)
        origin = self.run(
            "git", "remote", "get-url", "origin", cwd=self.active, capture=True
        ).stdout.strip()
        # A standalone clone retains its own object database when the first
        # in-place checkout is moved to the previous-release directory.
        self.run("git", "clone", "--no-hardlinks", "--no-checkout", self.active, self.candidate)
        self.run("git", "remote", "set-url", "origin", origin, cwd=self.candidate)
        self.run("git", "checkout", "--detach", self.target, cwd=self.candidate)
        node = pin_node_runtime(self.candidate, self.environment.get("TRADING_MAX_NODE_BINARY"))
        self.environment["PATH"] = str(node.parent) + os.pathsep + self.environment.get("PATH", "")
        self.run("uv", "sync", "--all-packages", "--no-dev", "--frozen", cwd=self.candidate)
        web = self.candidate / "apps" / "web"
        self.run("npm", "ci", "--no-audit", "--no-fund", cwd=web)
        self.run("npm", "run", "build", cwd=web)
        self.run(
            self.candidate / ".venv/bin/python",
            "tools/check_version_consistency.py",
            cwd=self.candidate,
        )
        if not (web / ".next/BUILD_ID").is_file():
            raise RuntimeError("candidate build is incomplete")
        if not (self.active / "apps/web/.next/BUILD_ID").is_file():
            raise RuntimeError("previous web build is unavailable for rollback")
        trim_build_dependencies(self.candidate)

    def capture_configuration(self) -> None:
        self.private.mkdir(parents=True, mode=0o700)
        if self.env_file.exists():
            atomic_write(self.private / "previous.env", self.env_file.read_bytes())
        for service in SERVICES:
            label = f"com.engram.trading-max-{service}"
            plist = self.agents / (label + ".plist")
            if not plist.is_file():
                raise RuntimeError(f"pre-provisioned service is missing: {label}")
            atomic_write(self.private / plist.name, plist.read_bytes())
            result = self.run(
                "launchctl", "print", f"gui/{self.uid}/{label}", capture=True, check=False
            )
            if result.returncode == 0:
                self.started_services.append(service)
        if not {"api", "web", "worker"}.issubset(self.started_services):
            raise RuntimeError("API, web and worker must already be provisioned and loaded")
        self.save_record("built")

    def stop(self) -> None:
        # Unloading KeepAlive jobs prevents an old worker from restarting in
        # the middle of the pointer change. The backup job also shares state.
        for service in reversed(SERVICES):
            domain = f"gui/{self.uid}/com.engram.trading-max-{service}"
            status = self.run("launchctl", "print", domain, capture=True, check=False)
            if status.returncode == 0:
                pid = re.search(r"\bpid = (\d+)", status.stdout)
                self.run("launchctl", "bootout", domain)
                if pid:
                    for _ in range(30):
                        try:
                            os.kill(int(pid[1]), 0)
                        except ProcessLookupError:
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError(f"service did not stop: {service}")

    def backup(self) -> None:
        result = self.run(
            self.candidate / ".venv/bin/python",
            self.candidate / "tools/manage_backups.py",
            "--repository",
            self.service / "backups/repository",
            "create",
            "--state-root",
            self.state,
            "--label",
            self.transaction,
            capture=True,
        )
        created = json.loads(result.stdout)
        if not created.get("snapshotRunId"):
            raise RuntimeError("deployment backup has no verified published snapshot")
        self.backup_manifest = created["manifest"]

    def activate(self) -> None:
        if not self.app.is_symlink():
            self.app.rename(self.previous)
        point_app(self.app, self.candidate)

    def configure(self) -> None:
        self.run(
            self.candidate / ".venv/bin/python",
            self.candidate / "deploy/macos/configure-host.py",
            "--preserve-credentials",
        )

    def migrate(self) -> None:
        self.run(self.candidate / "deploy/macos/migrate.sh", cwd=self.candidate)
        self.validate_state(self.candidate)

    def validate_state(self, release: Path) -> None:
        self.run(
            release / ".venv/bin/python",
            "-c",
            "from pathlib import Path; from trading_max.infrastructure import SnapshotStore; "
            "import sys; s=SnapshotStore(Path(sys.argv[1])).latest(); "
            "assert s is not None, 'no valid immutable snapshot'; "
            "print('Validated snapshot '+s.manifest.run_id)",
            self.state,
            cwd=release,
        )

    def start(self, *, restore=False) -> None:
        for service in self.started_services:
            name = f"com.engram.trading-max-{service}.plist"
            if restore:
                contents = (self.private / name).read_bytes()
            else:
                data = expand_plist_paths(
                    plistlib.loads((self.candidate / "deploy/macos" / name).read_bytes()),
                    self.service,
                    Path.home(),
                )
                data["EnvironmentVariables"] = {
                    **data.get("EnvironmentVariables", {}),
                    "TRADING_MAX_SERVICE_ROOT": str(self.service),
                    "TRADING_MAX_STATE_ROOT": str(self.state),
                }
                contents = plistlib.dumps(data)
            destination = self.agents / name
            atomic_write(destination, contents)
            self.run("launchctl", "bootstrap", f"gui/{self.uid}", destination, cwd=self.app)

    def health(self) -> None:
        for url in ("http://127.0.0.1:8421/ready", "http://127.0.0.1:3413/"):
            for _ in range(30):
                try:
                    with urlopen(url, timeout=5) as response:  # noqa: S310 - fixed loopback URLs
                        if response.status == 200:
                            if not url.endswith("/ready"):
                                break
                            payload = json.load(response)
                            if isinstance(payload, dict) and payload.get("status") == "ready":
                                break
                except (OSError, URLError, ValueError):
                    pass
                time.sleep(2)
            else:
                raise RuntimeError(f"readiness failed: {url}")
        worker = self.run(
            "launchctl", "print", f"gui/{self.uid}/com.engram.trading-max-worker", capture=True
        )
        if "state = running" not in worker.stdout:
            raise RuntimeError("worker is not running")

    def smoke(self) -> None:
        self.run(self.app / "deploy/macos/production-smoke.sh", cwd=self.app)

    def rollback(self) -> None:
        self.save_record("rolling-back")
        self.stop()
        # A failed initial rename can leave app unchanged. Never move/delete it
        # just to simulate a rollback that is already at the previous release.
        if self.previous.exists():
            point_app(self.app, self.previous)
        elif self.app.resolve() != self.active:
            raise RuntimeError("previous release is unavailable")
        saved_env = self.private / "previous.env"
        if saved_env.exists():
            atomic_write(self.env_file, saved_env.read_bytes())
        else:
            self.env_file.unlink(missing_ok=True)
        self.start(restore=True)
        self.health()
        self.smoke()
        self.save_record("rolled-back")

    def execute(self) -> None:
        try:
            self.save_record("building")
            self.build()
            self.save_record("preflight-backup")
            self.backup()
            self.capture_configuration()
            self.cutover_started = True
            self.save_record("stopping")
            self.stop()
            self.save_record("activating")
            self.activate()
            self.save_record("configuring")
            self.configure()
            self.save_record("migrating")
            self.migrate()
            self.save_record("starting")
            self.start()
            self.save_record("checking")
            self.health()
            self.smoke()
            self.save_record("healthy")
        except BaseException:
            if self.cutover_started:
                try:
                    self.rollback()
                except BaseException as rollback_error:
                    self.save_record("rollback-failed")
                    raise RuntimeError(
                        f"rollback failed; recovery record: {self.record}"
                    ) from rollback_error
            else:
                self.save_record("failed-before-cutover")
            raise


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[deploy] %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?")
    parser.add_argument(
        "--recover", type=Path, help="restore the retained runtime from a deployment record"
    )
    args = parser.parse_args()
    home = Path.home()
    service = Path(
        os.environ.get("TRADING_MAX_SERVICE_ROOT", home / "Services/trading-max")
    ).absolute()
    app = Path(os.environ.get("TRADING_MAX_APP_ROOT", service / "app")).absolute()
    state = Path(
        os.environ.get("TRADING_MAX_STATE_ROOT", home / "Library/Application Support/Trading Max")
    ).absolute()
    if app != service / "app":
        raise SystemExit("app must be the pre-provisioned service-root/app path")
    if bool(args.recover) == bool(args.target):
        parser.error("specify either a protected-main SHA or --recover")
    if args.target and not re.fullmatch(r"[0-9a-f]{40}", args.target):
        parser.error("target must be a full lowercase 40-character commit SHA")
    with (service / ".deployment.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("another deployment is running") from None

        def interrupted(_signum, _frame):
            raise KeyboardInterrupt("deployment interrupted")

        signal.signal(signal.SIGTERM, interrupted)
        if args.recover:
            record = args.recover.resolve(strict=True)
            if record.parent != (service / "deployments").resolve():
                parser.error("recovery record must belong to this service root")
            data = json.loads(record.read_text())
            if data.get("retiredRuntimePaths"):
                parser.error(
                    "this recovery record was retired by retention; use a retained rollback record"
                )
            if data["phase"] not in {
                "stopping",
                "backing-up",
                "activating",
                "configuring",
                "migrating",
                "starting",
                "checking",
                "healthy",
                "rolling-back",
                "rollback-failed",
            }:
                parser.error("record has no active cutover to recover")
            if Path(data["app"]) != app or Path(data["state"]) != state:
                parser.error("record paths do not match this host")
            deployment = object.__new__(Deployment)
            deployment.target = data["target"]
            deployment.service, deployment.app, deployment.state = service, app, state
            deployment.record = record
            deployment.active = Path(data["originalActive"])
            deployment.candidate = Path(data["candidate"])
            deployment.previous = Path(data["previous"])
            deployment.private = Path(data["privateBackup"])
            if (
                deployment.candidate.parent != service / "releases"
                or deployment.previous.parent != service / "releases"
            ):
                parser.error("retained runtimes must belong to this service")
            if deployment.private.parent != state / "secrets/deployment-backups":
                parser.error("configuration backup must belong to this state root")
            deployment.env_file = state / "secrets/trading_max.env"
            deployment.agents = home / "Library/LaunchAgents"
            deployment.uid = os.getuid()
            deployment.started_services = data["loadedServices"]
            if not set(deployment.started_services).issubset(SERVICES):
                parser.error("record contains unknown services")
            deployment.environment = {
                **os.environ,
                "TRADING_MAX_SERVICE_ROOT": str(service),
                "TRADING_MAX_STATE_ROOT": str(state),
            }
            deployment.rollback()
        else:
            deployment = Deployment(args.target, service, app, state)
            deployment.execute()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
