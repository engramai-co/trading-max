"""Operator CLI for first-run local workstation setup and diagnostics."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path

from . import __version__
from .backup import create_backup
from .credentials import DEFAULT_CREDENTIAL_SERVICE
from .infrastructure import SqliteDatabase
from .onboarding import OnboardingError, OnboardingOptions, onboard, repository_root
from .source_checkout import (
    CANONICAL_REPOSITORY,
    SourceCheckoutError,
    canonical_main_sha,
    inspect_source_checkout,
)

MAX_DIAGNOSTIC_COPY_BYTES = 64 * 1024 * 1024


class _InspectionLimited(ValueError):
    """A read-only check could not establish a result within its safe limits."""


def default_state_root() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Trading Max"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        return Path(app_data or Path.home() / "AppData" / "Roaming") / "Trading Max"
    data_home = os.environ.get("XDG_DATA_HOME")
    return Path(data_home or Path.home() / ".local" / "share") / "trading-max"


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(f"{key}={shlex.quote(value)}" for key, value in values.items())
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    temporary.write_text(content + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def _read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValueError(f"invalid bootstrap line {line_number}: {path}")
        key, raw = stripped.split("=", 1)
        key = key.strip()
        if not key or any(character.isspace() for character in key):
            raise ValueError(f"invalid bootstrap key on line {line_number}: {path}")
        try:
            parsed = shlex.split(raw, comments=False, posix=True)
        except ValueError as exc:
            raise ValueError(f"invalid bootstrap value on line {line_number}: {path}") from exc
        values[key] = parsed[0] if parsed else ""
    return values


def _new_credential_service(state_root: Path) -> str:
    """Return a stable namespace choice for a newly initialized state root."""

    if state_root == default_state_root().expanduser().resolve():
        # Preserve the historical namespace for the one conventional local
        # installation. Custom state roots are independent installations.
        return DEFAULT_CREDENTIAL_SERVICE
    return f"{DEFAULT_CREDENTIAL_SERVICE}.{secrets.token_hex(16)}"


def _bootstrap_defaults(
    state_root: Path,
    *,
    token: str,
    credential_service: str,
) -> dict[str, str]:
    return {
        "TRADING_MAX_ENV": "production",
        "TRADING_MAX_DEPLOYMENT_MODE": "local_workstation",
        "TRADING_MAX_DATA_ROOT": str(state_root),
        "TRADING_MAX_API_HOST": "127.0.0.1",
        "TRADING_MAX_API_PORT": "8421",
        "TRADING_MAX_API_TOKEN": token,
        "TRADING_MAX_CREDENTIAL_SERVICE": credential_service,
        "PORTFOLIO_BACKEND_URL": "http://127.0.0.1:8421",
        "PORTFOLIO_BACKEND_TOKEN": token,
        "TRADING_MAX_ALLOWED_ORIGINS": ("http://127.0.0.1:3413,http://localhost:3413"),
        "TRADING_MAX_LLM_PROVIDER": "fake",
        "TRADING_MAX_LLM_MODEL": "gpt-5.6-luna",
        # Build the security catalog incrementally on a new workstation.  A
        # later refresh reuses durable records and advances through deferred
        # ETF constituents instead of blocking first-run onboarding on the
        # entire look-through universe.
        "TRADING_MAX_SECURITY_PROFILE_REQUEST_BUDGET": "48",
        "TRADING_MAX_NIGHTLY_ENABLED": "false",
        "TRADING_MAX_INTRADAY_ENABLED": "false",
        "NEXT_TELEMETRY_DISABLED": "1",
    }


def setup(state_root: Path) -> int:
    state_root = state_root.expanduser().resolve()
    state_root.mkdir(parents=True, exist_ok=True)
    env_path = state_root / "secrets" / "trading_max.env"
    existing = _read_env(env_path)
    token = (
        existing.get("TRADING_MAX_API_TOKEN")
        or existing.get("PORTFOLIO_BACKEND_TOKEN")
        or secrets.token_urlsafe(48)
    )
    credential_service = existing.get("TRADING_MAX_CREDENTIAL_SERVICE") or (
        _new_credential_service(state_root)
    )
    defaults = _bootstrap_defaults(
        state_root,
        token=token,
        credential_service=credential_service,
    )
    values = {**defaults, **existing}
    # The two sides authenticate with one internal token. If either key was
    # missing, fill it without changing an explicitly configured existing one.
    values.setdefault("TRADING_MAX_API_TOKEN", token)
    values.setdefault("PORTFOLIO_BACKEND_TOKEN", token)
    if values != existing:
        _write_env(env_path, values)
    else:
        env_path.chmod(0o600)
    database = SqliteDatabase(state_root / "trading_max.db")
    database.close()
    action = (
        "updated"
        if existing and values != existing
        else ("already initialized" if existing else "initialized")
    )
    print(f"{action} Trading Max {__version__}")
    print(f"state root: {state_root}")
    print(f"bootstrap file: {env_path}")
    print(f"bootstrap analysis provider: {values['TRADING_MAX_LLM_PROVIDER'] or 'not configured'}")
    print("provider access is not checked; review the active configuration in Settings")
    return 0


def _copy_diagnostic_file(source: Path, destination: Path, size: int) -> None:
    """Copy only the bounded file length observed before the diagnostic read."""

    with source.open("rb") as reader, destination.open("xb") as writer:
        remaining = size
        while remaining:
            data = reader.read(min(1024 * 1024, remaining))
            if not data:
                raise _InspectionLimited(
                    "state database changed during inspection; retry doctor when idle"
                )
            writer.write(data)
            remaining -= len(data)


def _migration_versions(database_path: Path) -> list[str]:
    """Inspect migrations without creating or changing state-root sidecars."""

    def signature(path: Path) -> tuple[int, int, int, int] | None:
        try:
            metadata = path.stat()
        except FileNotFoundError:
            return None
        return (
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )

    # SQLite mode=ro can still create -wal/-shm files in a writable state
    # directory. immutable=1 avoids that but ignores uncheckpointed WAL data.
    # A private diagnostic copy lets SQLite read that WAL without modifying
    # the installation. Fail closed if a writer changes either input while
    # the copy is being made.
    wal_path = database_path.with_name(f"{database_path.name}-wal")
    journal_path = database_path.with_name(f"{database_path.name}-journal")
    paths = (database_path, wal_path, journal_path)
    try:
        before = {path: signature(path) for path in paths}
        if before[journal_path] is not None and before[journal_path][1] > 0:
            raise _InspectionLimited("an active rollback journal prevents a read-only schema check")
        if before[wal_path] is None or before[wal_path][1] == 0:
            # No uncheckpointed frames exist. Validate the observation after
            # querying so a concurrent writer cannot silently invalidate it.
            versions = _read_migration_versions(database_path, immutable=True)
            if before != {path: signature(path) for path in paths}:
                raise _InspectionLimited(
                    "state database changed during inspection; retry doctor when idle"
                )
            return versions
        copy_size = sum(metadata[1] for metadata in before.values() if metadata is not None)
        if copy_size > MAX_DIAGNOSTIC_COPY_BYTES:
            raise _InspectionLimited(
                "DB/WAL exceed the 64 MiB diagnostic-copy limit; schema is not verified. "
                "Recheck after a normal application shutdown or maintenance checkpoint"
            )
        with tempfile.TemporaryDirectory(prefix="trading-max-doctor-") as temporary:
            copied_database = Path(temporary) / database_path.name
            for path, metadata in before.items():
                if metadata is not None:
                    _copy_diagnostic_file(path, Path(temporary) / path.name, metadata[1])
            if before != {path: signature(path) for path in paths}:
                raise _InspectionLimited(
                    "state database changed during inspection; retry doctor when idle"
                )
            return _read_migration_versions(copied_database)
    except OSError as exc:
        raise ValueError("could not open the state database read-only") from exc


def _read_migration_versions(database_path: Path, *, immutable: bool = False) -> list[str]:
    try:
        options = "mode=ro&immutable=1" if immutable else "mode=ro"
        connection = sqlite3.connect(f"{database_path.as_uri()}?{options}", uri=True)
    except sqlite3.Error as exc:
        raise ValueError("could not open the state database read-only") from exc
    connection.row_factory = sqlite3.Row
    try:
        return [
            row["version"]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            ).fetchall()
        ]
    except sqlite3.Error as exc:
        raise ValueError("database migration ledger is unavailable") from exc
    finally:
        connection.close()


def _latest_packaged_migration(app_root: Path) -> str:
    migrations = sorted((app_root / "backend" / "migrations").glob("*.sql"))
    if not migrations:
        raise ValueError("packaged database migrations are unavailable")
    return migrations[-1].name


def _print_runtime_check_scope() -> None:
    print("credential store availability: not checked")
    print("runtime readiness: not checked; verify /ready after starting the application")
    print("provider access: not checked; test configured providers in Settings")


def doctor(
    state_root: Path,
    *,
    app_root: Path | None = None,
    check_updates: bool = False,
) -> int:
    state_root = state_root.expanduser().resolve()
    app_root = (app_root or repository_root()).expanduser().resolve()
    database_path = state_root / "trading_max.db"
    bootstrap_path = state_root / "secrets" / "trading_max.env"
    failures: list[str] = []
    if not database_path.is_file():
        print("not initialized: run `trading-max setup` first")
        return 1
    versions: list[str] | None = None
    inspection_limitation: str | None = None
    try:
        expected_schema = _latest_packaged_migration(app_root)
        versions = _migration_versions(database_path)
    except _InspectionLimited as exc:
        inspection_limitation = str(exc)
    except ValueError as exc:
        print(f"doctor failed: {exc}")
        return 1
    if versions == []:
        print("database has no migrations")
        return 1
    if versions and versions[-1] != expected_schema:
        failures.append(f"database schema is {versions[-1]}; source expects {expected_schema}")
    if not bootstrap_path.is_file():
        failures.append("bootstrap file is missing")
    else:
        if os.name == "posix" and stat.S_IMODE(bootstrap_path.stat().st_mode) != 0o600:
            failures.append("bootstrap file permissions must be 0600")
        try:
            bootstrap = _read_env(bootstrap_path)
        except UnicodeError:
            failures.append("bootstrap file is not valid UTF-8")
            bootstrap = {}
        except OSError:
            failures.append("bootstrap file could not be read")
            bootstrap = {}
        except ValueError as exc:
            failures.append(str(exc))
            bootstrap = {}
        api_token = bootstrap.get("TRADING_MAX_API_TOKEN", "")
        proxy_token = bootstrap.get("PORTFOLIO_BACKEND_TOKEN", "")
        if not api_token.strip():
            failures.append("bootstrap internal API token is missing")
        if not proxy_token.strip():
            failures.append("bootstrap web proxy token is missing")
        if (
            api_token.strip()
            and proxy_token.strip()
            and not secrets.compare_digest(api_token.encode("utf-8"), proxy_token.encode("utf-8"))
        ):
            failures.append("bootstrap internal API and web proxy tokens do not match")
        credential_service = bootstrap.get("TRADING_MAX_CREDENTIAL_SERVICE", "").strip()
        if not credential_service:
            failures.append("bootstrap credential-service namespace is missing")
        elif (
            credential_service == DEFAULT_CREDENTIAL_SERVICE
            and state_root != default_state_root().expanduser().resolve()
        ):
            failures.append(
                "custom state root uses the shared default credential namespace; "
                "plan an explicit credential migration before isolating this installation"
            )
        configured_root = bootstrap.get("TRADING_MAX_DATA_ROOT")
        if not configured_root or not configured_root.strip():
            failures.append("bootstrap data root is missing")
        else:
            try:
                data_root = Path(configured_root).expanduser()
                if not data_root.is_absolute():
                    failures.append("bootstrap data root must be an absolute path")
                elif data_root.resolve() != state_root:
                    failures.append("bootstrap data root does not match the requested state root")
            except (OSError, ValueError):
                failures.append("bootstrap data root is invalid")

    try:
        source = inspect_source_checkout(app_root)
    except SourceCheckoutError as exc:
        failures.append(str(exc))
        source = None
    update_current: bool | None = None
    if source is not None:
        if source.canonical_remote is None:
            failures.append(f"checkout has no {CANONICAL_REPOSITORY} remote")
        if source.dirty:
            failures.append("source worktree has uncommitted changes")
        if check_updates and source.canonical_remote is not None:
            try:
                current_main = canonical_main_sha(source)
            except SourceCheckoutError as exc:
                failures.append(str(exc))
            else:
                update_current = current_main == source.commit
                if not update_current:
                    failures.append(
                        f"source update available: local {source.commit[:12]}, "
                        f"canonical main {current_main[:12]}"
                    )

    print(f"Trading Max {__version__} is initialized")
    print(f"state root: {state_root}")
    print(f"schema: {versions[-1] if versions else 'not verified'} (expected {expected_schema})")
    if inspection_limitation:
        print(f"schema inspection limit: {inspection_limitation}")
    if source is not None:
        source_label = (
            f"{CANONICAL_REPOSITORY}@{source.commit[:12]}"
            if source.canonical_remote is not None
            else source.commit[:12]
        )
        print(f"source: {source_label} ({source.branch})")
        print(f"canonical source: {'verified' if source.canonical_remote else 'not verified'}")
        print(f"worktree: {'modified' if source.dirty else 'clean'}")
        if update_current:
            print("updates: canonical main is current")
    _print_runtime_check_scope()
    capacity_path = state_root / "runtime/storage-budget.json"
    if capacity_path.is_file():
        try:
            capacity = json.loads(capacity_path.read_text())
            used, limit = capacity["usedBytes"], capacity["budgetBytes"]
            if type(used) is not int or type(limit) is not int or used < 0 or limit <= 0:
                raise ValueError("invalid capacity values")
            print(
                f"installation storage: {used / 1e9:.2f} / {limit / 1e9:.2f} GB ({capacity['status']})"
            )
            print(f"storage census: {capacity['measuredAt']}")
            if used >= limit:
                failures.append(
                    "installation exceeds its storage budget; inspect the capacity report"
                )
        except (OSError, KeyError, TypeError, ValueError):
            print("installation storage: capacity report unavailable")
    if failures:
        print("doctor found problems:")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1
    if inspection_limitation:
        print("doctor: configuration check incomplete")
        return 1
    print("doctor: configuration checks passed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trading-max")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    setup_parser = subparsers.add_parser(
        "setup",
        help="initialize a local workstation state root",
    )
    setup_parser.add_argument("--state-root", type=Path)
    doctor_parser = subparsers.add_parser(
        "doctor",
        help="check local state, source provenance, and database migrations",
    )
    doctor_parser.add_argument("--state-root", type=Path)
    doctor_parser.add_argument("--app-root", type=Path, default=repository_root())
    doctor_parser.add_argument(
        "--check-updates",
        action="store_true",
        help="compare the local revision with canonical protected main without modifying it",
    )
    backup_parser = subparsers.add_parser(
        "backup",
        help="create a consistent credential-free local backup",
    )
    backup_parser.add_argument("--state-root", type=Path)
    backup_parser.add_argument("--destination", type=Path, required=True)
    backup_parser.add_argument("--retain", type=int, default=14)
    onboard_parser = subparsers.add_parser(
        "onboard",
        aliases=["init"],
        help="install, configure, and verify a local workstation",
    )
    onboard_parser.add_argument("--state-root", type=Path)
    onboard_parser.add_argument("--app-root", type=Path, default=repository_root())
    onboard_parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="skip secret prompts; configure providers later in Settings",
    )
    onboard_parser.add_argument(
        "--skip-build",
        action="store_true",
        help="reuse an existing verified web build",
    )
    service_group = onboard_parser.add_mutually_exclusive_group()
    service_group.add_argument(
        "--install-service",
        action="store_true",
        help="install the supported per-user macOS service without prompting",
    )
    service_group.add_argument(
        "--skip-service",
        action="store_true",
        help="leave startup to deploy/local/start.sh",
    )
    onboard_parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    configured_root = os.environ.get("TRADING_MAX_STATE_ROOT")
    state_root = args.state_root or (
        Path(configured_root) if configured_root else default_state_root()
    )
    if args.command == "setup":
        return setup(state_root)
    if args.command in {"onboard", "init"}:
        if args.non_interactive and not sys.stdin.isatty():
            interactive = False
        else:
            interactive = not args.non_interactive
        service_action = (
            "install"
            if args.install_service
            else "skip"
            if args.skip_service or not interactive
            else "ask"
        )
        options = OnboardingOptions(
            app_root=args.app_root,
            state_root=state_root,
            interactive=interactive,
            build_web=not args.skip_build,
            service_action=service_action,
            open_browser=not args.no_browser,
        )
        try:
            return onboard(options, initialize=setup)
        except OnboardingError as exc:
            print(f"onboarding failed: {exc}", file=sys.stderr)
            return 1
    if args.command == "backup":
        archive = create_backup(
            state_root,
            args.destination,
            retain=args.retain,
        )
        print(f"backup created: {archive}")
        return 0
    return doctor(
        state_root,
        app_root=args.app_root,
        check_updates=args.check_updates,
    )


if __name__ == "__main__":
    raise SystemExit(main())
