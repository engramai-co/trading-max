"""Load and validate API runtime configuration from the local environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import ip_address
from pathlib import Path
from zoneinfo import ZoneInfo

APP_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ALLOWED_ORIGINS = (
    "http://127.0.0.1:3412",
    "http://localhost:3412",
)
DEFAULT_FULL_REFRESH_TIMES = ("06:30", "12:00", "17:30", "22:30")


def default_data_root() -> Path:
    """Return a safe state root for the current execution environment.

    Production launchd services always inject TRADING_MAX_DATA_ROOT. Keeping a
    repository-local development default avoids writing a developer's home
    directory merely by importing the FastAPI app in tests or tooling.
    """

    environment = os.environ.get("TRADING_MAX_ENV", "development").strip().lower()
    configured = os.environ.get("TRADING_MAX_DATA_ROOT")
    if configured:
        raw = Path(configured).expanduser()
        if environment == "production" and not raw.is_absolute():
            raise RuntimeError("TRADING_MAX_DATA_ROOT must be an absolute path in production")
        resolved = raw.resolve()
        if environment == "production" and (resolved == APP_ROOT or APP_ROOT in resolved.parents):
            raise RuntimeError("TRADING_MAX_DATA_ROOT must be outside the application checkout")
        return resolved
    if environment != "production":
        return (APP_ROOT / "runtime").resolve()
    raise RuntimeError("TRADING_MAX_DATA_ROOT must be explicitly configured in production")


def _bool_from_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _full_refresh_times_from_env() -> tuple[str, ...]:
    raw = os.environ.get("TRADING_MAX_FULL_REFRESH_TIMES")
    if raw is not None:
        return tuple(value.strip() for value in raw.split(",") if value.strip())
    if "TRADING_MAX_NIGHTLY_HOUR" in os.environ or "TRADING_MAX_NIGHTLY_MINUTE" in os.environ:
        hour = int(os.environ.get("TRADING_MAX_NIGHTLY_HOUR", "6"))
        minute = int(os.environ.get("TRADING_MAX_NIGHTLY_MINUTE", "30"))
        return (f"{hour:02d}:{minute:02d}",)
    return DEFAULT_FULL_REFRESH_TIMES


@dataclass(frozen=True, slots=True)
class Settings:
    data_root: Path
    deployment_mode: str = "local_workstation"
    api_token: str | None = None
    api_host: str = "127.0.0.1"
    api_port: int = 8421
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS
    nightly_enabled: bool = False
    full_refresh_times: tuple[str, ...] = DEFAULT_FULL_REFRESH_TIMES
    nightly_timezone: str = "Europe/London"
    intraday_enabled: bool = False
    intraday_interval_seconds: int = 600
    intraday_timezone: str = "Europe/London"
    intraday_window_start: str = "00:00"
    intraday_window_end: str = "00:00"
    intraday_weekdays: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7)
    intraday_retention_days: int = 40
    performance_enabled: bool | None = None
    performance_interval_seconds: int = 1800
    research_enabled: bool | None = None
    daily_reconciliation_time: str = "22:30"
    alert_monitor_enabled: bool = False
    alert_held_interval_seconds: int = 300
    alert_watchlist_interval_seconds: int = 900
    embedded_worker: bool = False
    worker_lease_seconds: int = 300
    worker_poll_seconds: float = 1.0
    llm_provider: str = "fake"
    llm_model: str = "gpt-5.4-mini"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    opencode_api_key: str | None = None
    deepseek_api_key: str | None = None
    deepseek_base_url: str = "https://api.deepseek.com"

    @classmethod
    def from_env(cls) -> Settings:
        origins = tuple(
            value.strip()
            for value in os.environ.get("TRADING_MAX_ALLOWED_ORIGINS", "").split(",")
            if value.strip()
        )
        return cls(
            data_root=default_data_root(),
            deployment_mode=os.environ.get(
                "TRADING_MAX_DEPLOYMENT_MODE",
                "local_workstation",
            )
            .strip()
            .lower(),
            api_token=os.environ.get("TRADING_MAX_API_TOKEN") or None,
            api_host=os.environ.get("TRADING_MAX_API_HOST", "127.0.0.1").strip(),
            api_port=int(os.environ.get("TRADING_MAX_API_PORT", "8421")),
            allowed_origins=origins or DEFAULT_ALLOWED_ORIGINS,
            nightly_enabled=_bool_from_env(
                "TRADING_MAX_RESEARCH_ENABLED",
                _bool_from_env("TRADING_MAX_NIGHTLY_ENABLED", False),
            ),
            full_refresh_times=_full_refresh_times_from_env(),
            nightly_timezone=os.environ.get("TRADING_MAX_NIGHTLY_TIMEZONE", "Europe/London"),
            intraday_enabled=_bool_from_env(
                "TRADING_MAX_LIVE_ENABLED",
                _bool_from_env("TRADING_MAX_INTRADAY_ENABLED", False),
            ),
            intraday_interval_seconds=int(
                os.environ.get("TRADING_MAX_INTRADAY_INTERVAL_SECONDS", "600")
            ),
            intraday_timezone=os.environ.get("TRADING_MAX_INTRADAY_TIMEZONE", "Europe/London"),
            intraday_window_start=os.environ.get("TRADING_MAX_INTRADAY_WINDOW_START", "00:00"),
            intraday_window_end=os.environ.get("TRADING_MAX_INTRADAY_WINDOW_END", "00:00"),
            intraday_weekdays=tuple(
                int(value)
                for value in os.environ.get(
                    "TRADING_MAX_INTRADAY_WEEKDAYS",
                    "1,2,3,4,5,6,7",
                ).split(",")
                if value.strip()
            ),
            intraday_retention_days=int(
                os.environ.get("TRADING_MAX_INTRADAY_RETENTION_DAYS", "40")
            ),
            performance_enabled=_bool_from_env(
                "TRADING_MAX_PERFORMANCE_ENABLED",
                _bool_from_env("TRADING_MAX_NIGHTLY_ENABLED", False),
            ),
            performance_interval_seconds=int(
                os.environ.get("TRADING_MAX_PERFORMANCE_INTERVAL_SECONDS", "1800")
            ),
            research_enabled=_bool_from_env(
                "TRADING_MAX_RESEARCH_ENABLED",
                _bool_from_env("TRADING_MAX_NIGHTLY_ENABLED", False),
            ),
            daily_reconciliation_time=os.environ.get(
                "TRADING_MAX_DAILY_RECONCILIATION_TIME",
                "22:30",
            ),
            alert_monitor_enabled=_bool_from_env(
                "TRADING_MAX_ALERT_MONITOR_ENABLED",
                False,
            ),
            alert_held_interval_seconds=int(
                os.environ.get("TRADING_MAX_ALERT_HELD_INTERVAL_SECONDS", "300")
            ),
            alert_watchlist_interval_seconds=int(
                os.environ.get(
                    "TRADING_MAX_ALERT_WATCHLIST_INTERVAL_SECONDS",
                    "900",
                )
            ),
            embedded_worker=_bool_from_env("TRADING_MAX_EMBEDDED_WORKER", False),
            worker_lease_seconds=int(os.environ.get("TRADING_MAX_WORKER_LEASE_SECONDS", "300")),
            worker_poll_seconds=float(os.environ.get("TRADING_MAX_WORKER_POLL_SECONDS", "1")),
            llm_provider=os.environ.get("TRADING_MAX_LLM_PROVIDER", "fake"),
            llm_model=os.environ.get("TRADING_MAX_LLM_MODEL", "gpt-5.4-mini"),
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
            openai_base_url=os.environ.get(
                "OPENAI_BASE_URL",
                "https://api.openai.com/v1",
            ),
            opencode_api_key=os.environ.get("OPENCODE_API_KEY") or None,
            deepseek_api_key=os.environ.get("DEEPSEEK_API_KEY") or None,
            deepseek_base_url=os.environ.get(
                "DEEPSEEK_BASE_URL",
                "https://api.deepseek.com",
            ),
        )

    def validate(self) -> None:
        """Validate deployment-safe settings before creating the app."""

        if self.deployment_mode not in {"personal_tailnet", "local_workstation"}:
            raise RuntimeError(
                "TRADING_MAX_DEPLOYMENT_MODE must be personal_tailnet or local_workstation"
            )

        if not self.full_refresh_times:
            raise RuntimeError("TRADING_MAX_FULL_REFRESH_TIMES must contain at least one time")
        parsed_refresh_times: list[tuple[int, int]] = []
        for value in self.full_refresh_times:
            try:
                hour_text, minute_text = value.split(":", 1)
                hour, minute = int(hour_text), int(minute_text)
            except (ValueError, AttributeError) as exc:
                raise RuntimeError(
                    "TRADING_MAX_FULL_REFRESH_TIMES must contain comma-separated HH:MM times"
                ) from exc
            if not 0 <= hour <= 23 or not 0 <= minute <= 59:
                raise RuntimeError(
                    "TRADING_MAX_FULL_REFRESH_TIMES must contain comma-separated HH:MM times"
                )
            parsed_refresh_times.append((hour, minute))
        if len(set(parsed_refresh_times)) != len(parsed_refresh_times):
            raise RuntimeError("TRADING_MAX_FULL_REFRESH_TIMES must not contain duplicates")
        try:
            ZoneInfo(self.nightly_timezone)
            ZoneInfo(self.intraday_timezone)
        except Exception as exc:
            raise RuntimeError("nightly/intraday timezone is invalid") from exc
        if self.intraday_interval_seconds < 60:
            raise RuntimeError("TRADING_MAX_INTRADAY_INTERVAL_SECONDS must be at least 60")
        if self.performance_interval_seconds < 60:
            raise RuntimeError("TRADING_MAX_PERFORMANCE_INTERVAL_SECONDS must be at least 60")
        if self.daily_reconciliation_time not in self.full_refresh_times:
            raise RuntimeError(
                "TRADING_MAX_DAILY_RECONCILIATION_TIME must be one of the research times"
            )
        if self.intraday_retention_days <= 0:
            raise RuntimeError("TRADING_MAX_INTRADAY_RETENTION_DAYS must be positive")
        if not self.intraday_weekdays or any(
            weekday not in range(1, 8) for weekday in self.intraday_weekdays
        ):
            raise RuntimeError("TRADING_MAX_INTRADAY_WEEKDAYS must contain ISO weekdays 1-7")
        for name, value in (
            ("TRADING_MAX_INTRADAY_WINDOW_START", self.intraday_window_start),
            ("TRADING_MAX_INTRADAY_WINDOW_END", self.intraday_window_end),
        ):
            try:
                hour_text, minute_text = value.split(":", 1)
                hour, minute = int(hour_text), int(minute_text)
            except (ValueError, AttributeError) as exc:
                raise RuntimeError(f"{name} must use HH:MM format") from exc
            if not 0 <= hour <= 23 or not 0 <= minute <= 59:
                raise RuntimeError(f"{name} must use HH:MM format")
        if (
            self.intraday_window_start > self.intraday_window_end
            or self.intraday_window_start == self.intraday_window_end != "00:00"
        ):
            raise RuntimeError(
                "TRADING_MAX_INTRADAY_WINDOW_START must be before window end; "
                "00:00 to 00:00 represents a full natural day"
            )
        if self.alert_held_interval_seconds < 60:
            raise RuntimeError("TRADING_MAX_ALERT_HELD_INTERVAL_SECONDS must be at least 60")
        if self.alert_watchlist_interval_seconds < 60:
            raise RuntimeError("TRADING_MAX_ALERT_WATCHLIST_INTERVAL_SECONDS must be at least 60")
        if self.llm_provider not in {"fake", "openai", "deepseek", "opencode"}:
            raise RuntimeError(
                "TRADING_MAX_LLM_PROVIDER must be fake, openai, deepseek, or opencode"
            )
        # Provider secrets may live in the OS credential store and are loaded
        # by provider_runtime.py for each task. Bootstrap env keys remain a
        # migration fallback, not a startup requirement.
        host = self.api_host.strip("[]").lower()
        try:
            is_loopback = ip_address(host).is_loopback
        except ValueError:
            is_loopback = host == "localhost"
        if not is_loopback:
            raise RuntimeError(
                "TRADING_MAX_API_HOST must be loopback; remote access requires authentication"
            )
        if not 1 <= self.api_port <= 65535:
            raise RuntimeError("TRADING_MAX_API_PORT must be between 1 and 65535")

    def validate_runtime_mode(self) -> None:
        """Compatibility name for callers; the typed runtime is unconditional."""

        self.validate()
        environment = os.environ.get("TRADING_MAX_ENV", "development").strip().lower()
        if environment == "production":
            data_root = self.data_root.expanduser()
            if not data_root.is_absolute():
                raise RuntimeError("TRADING_MAX_DATA_ROOT must be an absolute path in production")
            if data_root.resolve() == APP_ROOT or APP_ROOT in data_root.resolve().parents:
                raise RuntimeError("TRADING_MAX_DATA_ROOT must be outside the application checkout")
            if self.embedded_worker:
                raise RuntimeError("TRADING_MAX_EMBEDDED_WORKER=true is not allowed in production")
            if not self.api_token:
                raise RuntimeError("TRADING_MAX_API_TOKEN is required in production")
