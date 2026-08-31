"""Configure a Trading Max macOS host without exposing stored credentials."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import sys
from datetime import date
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
for import_root in (APP_ROOT, APP_ROOT / "backend" / "src"):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

HOME = Path.home()
SERVICE_ROOT = Path(
    os.environ.get("TRADING_MAX_SERVICE_ROOT", HOME / "Services" / "trading-max")
).expanduser()
STATE_ROOT = Path(
    os.environ.get(
        "TRADING_MAX_STATE_ROOT",
        HOME / "Library" / "Application Support" / "Trading Max",
    )
).expanduser()
ENV_PATH = STATE_ROOT / "secrets" / "trading_max.env"
CREDENTIAL_SERVICE = os.environ.get(
    "TRADING_MAX_CREDENTIAL_SERVICE",
    "com.engram.trading-max.credentials",
)


def read_existing() -> dict[str, str]:
    if not ENV_PATH.is_file():
        return {}
    values: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        parsed = shlex.split(raw)
        if parsed:
            values[key] = parsed[0]
    return values


def credentials_from_stdin() -> dict[str, dict[str, str]]:
    payload = json.load(sys.stdin)
    values: dict[str, dict[str, str]] = {}
    for profile in ("invest", "isa"):
        record = payload.get(profile) or {}
        api_key = str(record.get("api_key") or "").strip()
        api_secret = str(record.get("api_secret") or "").strip()
        if not api_key or not api_secret:
            raise ValueError(f"incomplete {profile} credential payload")
        values[profile] = {"api_key": api_key, "api_secret": api_secret}
    return values


def credential_store():
    """Build the native credential adapter lazily for operator commands/tests."""

    from services.api.trading_max_api.credentials import KeyringCredentialStore

    return KeyringCredentialStore(service=CREDENTIAL_SERVICE)


def migrate_credentials(
    values: dict[str, str],
    *,
    stdin_credentials: dict[str, dict[str, str]] | None = None,
    deepseek_api_key: str | None = None,
    opencode_api_key: str | None = None,
) -> set[str]:
    """Move legacy env/stdin secrets into the OS store and erase env copies."""

    payloads = stdin_credentials or {}
    to_store: dict[str, str] = {}
    migrated_references: set[str] = set()
    remove_from_env: set[str] = set()
    for profile in ("invest", "isa"):
        prefix = profile.upper()
        supplied = payloads.get(profile)
        env_key = values.get(f"T212_{prefix}_API_KEY", "").strip()
        env_secret = values.get(f"T212_{prefix}_API_SECRET", "").strip()
        api_key = (supplied or {}).get("api_key", env_key).strip()
        api_secret = (supplied or {}).get("api_secret", env_secret).strip()
        if api_key or api_secret:
            if not api_key or not api_secret:
                raise ValueError(f"incomplete {profile} credential payload")
            to_store[f"trading212:{profile}"] = json.dumps(
                {"api_key": api_key, "api_secret": api_secret},
                separators=(",", ":"),
            )
            migrated_references.add(f"trading212:{profile}")
        remove_from_env.update({f"T212_{prefix}_API_KEY", f"T212_{prefix}_API_SECRET"})

    legacy_deepseek = values.get("DEEPSEEK_API_KEY", "").strip()
    if deepseek_api_key or legacy_deepseek:
        to_store["deepseek:default"] = (deepseek_api_key or legacy_deepseek or "").strip()
        migrated_references.add("deepseek:default")
    legacy_opencode = values.get("OPENCODE_API_KEY", "").strip()
    if opencode_api_key or legacy_opencode:
        to_store["opencode:default"] = (opencode_api_key or legacy_opencode or "").strip()
        migrated_references.add("opencode:default")
    legacy_openai = values.get("OPENAI_API_KEY", "").strip()
    if legacy_openai:
        to_store["openai:default"] = legacy_openai
        migrated_references.add("openai:default")
    if to_store:
        store = credential_store()
        for reference, secret in to_store.items():
            store.put(reference, secret)
    for key in remove_from_env | {"DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY"}:
        values.pop(key, None)
    return migrated_references


def persist_integration_metadata(
    references: set[str],
    *,
    deepseek_model: str,
    opencode_model: str,
    deepseek_base_url: str,
) -> None:
    """Create non-secret Settings rows for credentials migrated on this run."""

    if not references:
        return
    from services.api.trading_max_api.credentials import secret_fingerprint
    from services.api.trading_max_api.llm_routing import PROVIDER_REGISTRY
    from services.api.trading_max_api.settings import SettingsRepository

    store = credential_store()
    repository = SettingsRepository(STATE_ROOT)
    try:
        for reference in sorted(references):
            provider, _, profile = reference.partition(":")
            secret = store.get(reference)
            if not secret:
                continue
            if provider == "deepseek":
                spec = PROVIDER_REGISTRY["deepseek"]
                model = deepseek_model if deepseek_model in spec.models else spec.default_model
            elif provider == "opencode":
                spec = PROVIDER_REGISTRY["opencode"]
                model = opencode_model if opencode_model in spec.models else spec.default_model
            else:
                model = None
            repository.save_integration(
                provider=provider,
                profile=None if provider == "deepseek" else profile,
                enabled=True,
                model=model,
                base_url=(
                    deepseek_base_url
                    if provider == "deepseek"
                    else "https://opencode.ai/zen/go/v1"
                    if provider == "opencode"
                    else None
                ),
                credential_fingerprint=secret_fingerprint(secret),
                test_status="untested",
            )
    finally:
        repository.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--credentials-stdin",
        action="store_true",
        help="merge Invest and ISA credential JSON from standard input",
    )
    parser.add_argument(
        "--llm-provider",
        choices=("fake", "openai", "deepseek", "opencode"),
        help="override the persisted LLM provider",
    )
    parser.add_argument(
        "--llm-model",
        help="override the persisted LLM model",
    )
    llm_key_group = parser.add_mutually_exclusive_group()
    llm_key_group.add_argument(
        "--deepseek-api-key-stdin",
        action="store_true",
        help="read DEEPSEEK_API_KEY from the first stdin line",
    )
    llm_key_group.add_argument(
        "--opencode-api-key-stdin",
        action="store_true",
        help="read OPENCODE_API_KEY from the first stdin line",
    )
    parser.add_argument(
        "--defer-credential-migration",
        action="store_true",
        help="keep existing 0600 env credentials when a headless Keychain is unavailable",
    )
    args = parser.parse_args()

    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    values = read_existing()
    stdin_credentials = credentials_from_stdin() if args.credentials_stdin else None
    deepseek_api_key: str | None = None
    opencode_api_key: str | None = None
    if args.deepseek_api_key_stdin or args.opencode_api_key_stdin:
        if getattr(sys.stdin, "isatty", lambda: False)():
            import getpass

            label = "DEEPSEEK_API_KEY" if args.deepseek_api_key_stdin else "OPENCODE_API_KEY"
            api_key = getpass.getpass(f"{label}: ").strip()
        else:
            api_key = sys.stdin.readline().strip()
        if not api_key:
            label = "DEEPSEEK_API_KEY" if args.deepseek_api_key_stdin else "OPENCODE_API_KEY"
            raise ValueError(f"empty {label} on stdin")
        if args.deepseek_api_key_stdin:
            deepseek_api_key = api_key
        else:
            opencode_api_key = api_key

    try:
        migrated_profiles = migrate_credentials(
            values,
            stdin_credentials=stdin_credentials,
            deepseek_api_key=deepseek_api_key,
            opencode_api_key=opencode_api_key,
        )
    except Exception as exc:
        if not args.defer_credential_migration:
            raise
        print(
            "warning: Keychain migration deferred; existing 0600 env credentials "
            f"remain in place ({type(exc).__name__})",
            file=sys.stderr,
        )
        migrated_profiles = set()

    token = values.get("TRADING_MAX_API_TOKEN") or secrets.token_urlsafe(48)
    llm_provider = args.llm_provider or values.get(
        "TRADING_MAX_LLM_PROVIDER",
        "fake",
    )
    llm_model = args.llm_model or values.get(
        "TRADING_MAX_LLM_MODEL",
        "gpt-5.4-mini",
    )
    broker_export_lookback_days = min(
        max(int(values.get("TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS", "365")), 1),
        365,
    )
    broker_export_floor = date.fromisoformat(
        values.get("TRADING_MAX_BROKER_EXPORT_FLOOR", "2016-01-01")
    )
    persist_integration_metadata(
        migrated_profiles,
        deepseek_model=llm_model,
        opencode_model=llm_model,
        deepseek_base_url=values.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )
    values.pop("TRADING_MAX_NIGHTLY_HOUR", None)
    values.pop("TRADING_MAX_NIGHTLY_MINUTE", None)
    values.update(
        {
            "TRADING_MAX_ENV": "production",
            "TRADING_MAX_DEPLOYMENT_MODE": "personal_tailnet",
            "TRADING_MAX_DATA_ROOT": str(STATE_ROOT),
            "TRADING_MAX_API_TOKEN": token,
            "TRADING_MAX_API_HOST": "127.0.0.1",
            "TRADING_MAX_API_PORT": "8421",
            "TRADING_MAX_NIGHTLY_ENABLED": "true",
            "TRADING_MAX_NIGHTLY_TIMEZONE": "Europe/London",
            "TRADING_MAX_FULL_REFRESH_TIMES": "06:30,12:00,17:30,22:30",
            "TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS": str(broker_export_lookback_days),
            "TRADING_MAX_BROKER_EXPORT_FLOOR": broker_export_floor.isoformat(),
            "TRADING_MAX_INTRADAY_ENABLED": "true",
            "TRADING_MAX_INTRADAY_INTERVAL_SECONDS": "600",
            "TRADING_MAX_INTRADAY_TIMEZONE": "Europe/London",
            "TRADING_MAX_INTRADAY_WINDOW_START": "00:00",
            "TRADING_MAX_INTRADAY_WINDOW_END": "00:00",
            "TRADING_MAX_INTRADAY_WEEKDAYS": "1,2,3,4,5,6,7",
            "TRADING_MAX_INTRADAY_RETENTION_DAYS": "40",
            "TRADING_MAX_ALERT_MONITOR_ENABLED": "true",
            "TRADING_MAX_ALERT_HELD_INTERVAL_SECONDS": "300",
            "TRADING_MAX_ALERT_WATCHLIST_INTERVAL_SECONDS": "900",
            "TRADING_MAX_LLM_PROVIDER": llm_provider,
            "TRADING_MAX_LLM_MODEL": llm_model,
            "OPENAI_BASE_URL": values.get(
                "OPENAI_BASE_URL",
                "https://api.openai.com/v1",
            ),
            "DEEPSEEK_BASE_URL": values.get(
                "DEEPSEEK_BASE_URL",
                "https://api.deepseek.com",
            ),
            "TRADING_MAX_CREDENTIAL_SERVICE": CREDENTIAL_SERVICE,
            "PORTFOLIO_BACKEND_URL": "http://127.0.0.1:8421",
            "PORTFOLIO_BACKEND_TOKEN": token,
            "T212_DATA_DIR": str(STATE_ROOT / "trading212"),
            "T212_INVEST_ENVIRONMENT": "live",
            "T212_ISA_ENVIRONMENT": "live",
            "NEXT_TELEMETRY_DISABLED": "1",
        }
    )

    preferred_order = (
        "TRADING_MAX_ENV",
        "TRADING_MAX_DEPLOYMENT_MODE",
        "TRADING_MAX_DATA_ROOT",
        "TRADING_MAX_API_TOKEN",
        "TRADING_MAX_API_HOST",
        "TRADING_MAX_API_PORT",
        "TRADING_MAX_NIGHTLY_ENABLED",
        "TRADING_MAX_NIGHTLY_TIMEZONE",
        "TRADING_MAX_FULL_REFRESH_TIMES",
        "TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS",
        "TRADING_MAX_BROKER_EXPORT_FLOOR",
        "TRADING_MAX_INTRADAY_ENABLED",
        "TRADING_MAX_INTRADAY_INTERVAL_SECONDS",
        "TRADING_MAX_INTRADAY_TIMEZONE",
        "TRADING_MAX_INTRADAY_WINDOW_START",
        "TRADING_MAX_INTRADAY_WINDOW_END",
        "TRADING_MAX_INTRADAY_WEEKDAYS",
        "TRADING_MAX_INTRADAY_RETENTION_DAYS",
        "TRADING_MAX_ALERT_MONITOR_ENABLED",
        "TRADING_MAX_ALERT_HELD_INTERVAL_SECONDS",
        "TRADING_MAX_ALERT_WATCHLIST_INTERVAL_SECONDS",
        "TRADING_MAX_LLM_PROVIDER",
        "TRADING_MAX_LLM_MODEL",
        "OPENAI_BASE_URL",
        "DEEPSEEK_BASE_URL",
        "TRADING_MAX_CREDENTIAL_SERVICE",
        "PORTFOLIO_BACKEND_URL",
        "PORTFOLIO_BACKEND_TOKEN",
        "T212_DATA_DIR",
        "T212_INVEST_ENVIRONMENT",
        "T212_ISA_ENVIRONMENT",
        "NEXT_TELEMETRY_DISABLED",
    )
    ordered = [key for key in preferred_order if key in values]
    ordered.extend(sorted(set(values) - set(ordered)))
    content = "\n".join(f"{key}={shlex.quote(values[key])}" for key in ordered)
    ENV_PATH.write_text(content + "\n", encoding="utf-8")
    ENV_PATH.chmod(0o600)
    profiles = sorted(
        reference.split(":", 1)[1].upper()
        for reference in migrated_profiles
        if reference.startswith("trading212:")
    )
    print(f"configured {ENV_PATH}")
    print(f"credential profiles: {', '.join(profiles) or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
