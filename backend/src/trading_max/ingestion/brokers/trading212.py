"""Read-only Trading 212 adapter and normalized broker snapshot contracts.

The adapter intentionally exposes account data and official history exports
only. It has no order placement/cancellation methods. This adapter is the sole
broker/account ingestion boundary for the production worker.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
import time
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from datetime import UTC, date, datetime
from datetime import time as datetime_time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal, Self
from urllib.parse import urlparse

import httpx
from pydantic import Field, field_validator

from trading_max.credentials import (
    DEFAULT_CREDENTIAL_SERVICE,
    configured_credential_service,
    legacy_credential_lookup_enabled,
)
from trading_max.domain.contracts import DomainModel

API_BASE_URLS = {
    "demo": "https://demo.trading212.com/api/v0",
    "live": "https://live.trading212.com/api/v0",
}
READ_ONLY_GET_PATHS = frozenset(
    {
        "/equity/account/summary",
        "/equity/positions",
        "/equity/orders",
        "/equity/history/dividends",
        "/equity/history/exports",
        "/equity/history/orders",
        "/equity/history/transactions",
    }
)
EXPORT_POST_PATH = "/equity/history/exports"
FINISHED_EXPORT_STATUSES = frozenset({"Canceled", "Failed", "Finished"})
REQUIRED_EXPORT_COLUMNS = frozenset(
    {
        "Action",
        "Time (UTC)",
        "ISIN",
        "Ticker",
        "Name",
        "ID",
        "No. of shares",
        "Price / share",
        "Exchange rate",
        "Total",
        "Currency conversion fee",
    }
)
KEYCHAIN_SERVICE = "com.engram.trading-max.trading212"
LEGACY_KEYCHAIN_SERVICE = "portfolio-research-trading212-api"
SETTINGS_KEYCHAIN_SERVICE = DEFAULT_CREDENTIAL_SERVICE
KEYCHAIN_EXECUTABLE = "/usr/bin/security"


class Trading212Error(RuntimeError):
    """Base error for failed or unsafe broker operations."""


class Trading212CredentialsError(Trading212Error):
    """Raised when a profile's credentials are unavailable or malformed."""


class Trading212ExportError(Trading212Error):
    """Raised when an asynchronous broker export is invalid or fails."""


def _profile_token(profile: str) -> str:
    clean = profile.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", clean):
        raise ValueError("profile must contain only letters, numbers, '-' or '_'")
    return clean


def _environment_prefix(profile: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", _profile_token(profile).upper())


def _keychain_locations(profile: str) -> tuple[tuple[str, str], ...]:
    """Return this installation's credential locations in authoritative order."""

    locations = [
        (configured_credential_service(), f"trading212:{profile}"),
    ]
    if legacy_credential_lookup_enabled():
        locations.extend(
            [
                (KEYCHAIN_SERVICE, profile),
                (LEGACY_KEYCHAIN_SERVICE, profile),
            ]
        )
    return tuple(dict.fromkeys(locations))


def _keychain_credentials(profile: str) -> tuple[str, str] | None:
    """Read one JSON credential pair without ever printing the secret."""

    keyring_locations = _keychain_locations(profile)
    try:
        import keyring

        for service, account in keyring_locations:
            payload_text = keyring.get_password(service, account)
            if not payload_text:
                continue
            payload = json.loads(payload_text)
            api_key = str(payload.get("api_key", "")).strip()
            api_secret = str(payload.get("api_secret", "")).strip()
            if api_key and api_secret:
                return api_key, api_secret
    except Exception:
        # The explicit macOS fallback below keeps existing installs readable;
        # a production host still fails closed when neither store is usable.
        return None

    for service, account in keyring_locations:
        try:
            result = subprocess.run(  # noqa: S603 - fixed macOS executable and validated arguments
                [
                    KEYCHAIN_EXECUTABLE,
                    "find-generic-password",
                    "-a",
                    account,
                    "-s",
                    service,
                    "-w",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            return None
        if result.returncode != 0:
            continue
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise Trading212CredentialsError(
                f"invalid Trading 212 credential JSON in Keychain profile {profile!r}"
            ) from exc
        api_key = str(payload.get("api_key", "")).strip()
        api_secret = str(payload.get("api_secret", "")).strip()
        if not api_key or not api_secret:
            raise Trading212CredentialsError(
                f"incomplete Trading 212 credentials in Keychain profile {profile!r}"
            )
        return api_key, api_secret
    return None


class Trading212Credentials(DomainModel):
    profile: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    api_secret: str = Field(min_length=1)

    @classmethod
    def from_sources(cls, profile: str) -> Self:
        normalized = _profile_token(profile)
        token = _environment_prefix(normalized)
        key = ""
        secret = ""
        keychain = _keychain_credentials(normalized)
        if keychain is not None:
            key, secret = keychain
        elif legacy_credential_lookup_enabled():
            # Environment credentials remain supported for the historical
            # default installation. Isolated state roots never inherit ambient
            # shell credentials from another local instance.
            key = os.environ.get(f"T212_{token}_API_KEY", "").strip()
            secret = os.environ.get(f"T212_{token}_API_SECRET", "").strip()
        if not key or not secret:
            service = configured_credential_service()
            raise Trading212CredentialsError(
                f"missing credentials for profile {normalized!r}; configure Keychain "
                f"service {service!r}, account {f'trading212:{normalized}'!r}"
            )
        return cls(profile=normalized, api_key=key, api_secret=secret)

    @classmethod
    def from_environment(cls, profile: str) -> Self:
        """Backward-compatible name; Keychain is also checked after env."""

        return cls.from_sources(profile)


def default_data_root() -> Path:
    """Return private broker state outside the Git checkout."""

    override = os.environ.get("T212_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".local" / "share" / "trading-max" / "trading212"


def utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def export_window(
    start: date,
    end: date,
    *,
    now: datetime | None = None,
) -> tuple[datetime, datetime]:
    """Convert inclusive dates into an API-safe UTC interval."""

    now_utc = (now or datetime.now(UTC)).astimezone(UTC)
    if end < start:
        raise ValueError("export end date cannot be before start date")
    if end > now_utc.date():
        raise ValueError("export end date cannot be in the future")
    start_at = datetime.combine(start, datetime_time.min, tzinfo=UTC)
    end_at = (
        now_utc
        if end == now_utc.date()
        else datetime.combine(end, datetime_time.max, tzinfo=UTC).replace(microsecond=0)
    )
    if end_at <= start_at:
        raise ValueError("export interval must contain at least one second")
    return start_at, end_at


class BrokerAccountSummary(DomainModel):
    account_id: str | None = None
    currency: str = "GBP"
    total_value: Decimal
    cash_available: Decimal
    investments_value: Decimal
    investments_cost: Decimal
    realized_profit_loss: Decimal
    unrealized_profit_loss: Decimal

    @field_validator(
        "total_value",
        "cash_available",
        "investments_value",
        "investments_cost",
        "realized_profit_loss",
        "unrealized_profit_loss",
        mode="before",
    )
    @classmethod
    def decimalize(cls, value: object) -> Decimal:
        return _decimal(value)


class BrokerPosition(DomainModel):
    ticker: str
    broker_ticker: str = ""
    name: str = ""
    isin: str = ""
    quantity: Decimal
    current_price: Decimal
    price_currency: str = "GBP"
    current_value_gbp: Decimal
    total_cost_gbp: Decimal
    unrealized_profit_loss_gbp: Decimal
    fx_impact_gbp: Decimal | None = None

    @field_validator(
        "quantity",
        "current_price",
        "current_value_gbp",
        "total_cost_gbp",
        "unrealized_profit_loss_gbp",
        "fx_impact_gbp",
        mode="before",
    )
    @classmethod
    def decimalize(cls, value: object) -> Decimal | None:
        return None if value is None else _decimal(value)


class BrokerSnapshot(DomainModel):
    schema_version: int = 1
    profile: str
    environment: str
    fetched_at: datetime
    account: BrokerAccountSummary
    positions: list[BrokerPosition]
    reconciliation: ReconciliationResult | None = None


class BrokerSnapshotReconciliation(DomainModel):
    """Audit the independently fetched account summary and position list."""

    position_value_gbp: Decimal
    investments_value_gbp: Decimal
    position_delta_gbp: Decimal
    position_tolerance_gbp: Decimal
    account_total_delta_gbp: Decimal
    account_total_tolerance_gbp: Decimal
    positions_match_investments: bool
    cash_plus_investments_matches_total: bool


class ReconciliationDifference(DomainModel):
    instrument: str
    identity: str
    ledger_quantity: Decimal
    api_quantity: Decimal
    delta: Decimal


class ReconciliationResult(DomainModel):
    status: Literal["verified", "mismatch", "unverified", "unavailable"]
    coverage: Literal[
        "complete",
        "incomplete",
        "unsupported_corporate_action",
    ] = "complete"
    checked_at: datetime
    tolerance: Decimal
    ledger_instruments: int
    api_instruments: int
    differences: list[ReconciliationDifference] = Field(default_factory=list)
    note: str = ""


def _decimal(value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    text = str(value if value is not None else "0").strip().replace(",", "")
    try:
        return Decimal(text or "0")
    except InvalidOperation as exc:
        raise Trading212Error(f"invalid numeric broker value: {value!r}") from exc


def _utc(value: object) -> datetime:
    if isinstance(value, datetime):
        result = value
    else:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        result = result.replace(tzinfo=UTC)
    return result.astimezone(UTC)


class Trading212Client:
    """Allowlisted Trading 212 client.

    Account reads and official history export creation are supported because
    they are needed for the ingestion pipeline. Order placement, cancellation,
    and every other write endpoint are deliberately impossible through this
    class.
    """

    def __init__(
        self,
        credentials: Trading212Credentials,
        *,
        environment: str = "live",
        timeout_seconds: float = 30.0,
        http_client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if environment not in API_BASE_URLS:
            raise ValueError(f"environment must be one of {sorted(API_BASE_URLS)}")
        self.credentials = credentials
        self.environment = environment
        self.base_url = API_BASE_URLS[environment]
        self._http = http_client or httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=False,
            headers={"User-Agent": "trading-max/0.3"},
        )
        self._owns_http_client = http_client is None
        self._auth = httpx.BasicAuth(credentials.api_key, credentials.api_secret)
        self._sleep = sleep
        self._monotonic = monotonic
        self._origin = self.base_url.removesuffix("/api/v0")

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_http_client:
            self._http.close()

    @staticmethod
    def _canonical_path(path: str) -> str:
        parsed = urlparse(path)
        canonical = parsed.path
        if canonical.startswith("/api/v0"):
            canonical = canonical.removeprefix("/api/v0")
        return canonical

    def _api_url(self, path: str) -> str:
        parsed = urlparse(path)
        if parsed.scheme or parsed.netloc:
            raise Trading212Error("absolute API URLs are not accepted")
        if path.startswith("/api/v0/"):
            return f"{self._origin}{path}"
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.base_url}{path}"

    @classmethod
    def _assert_allowed(cls, method: str, path: str) -> None:
        canonical = cls._canonical_path(path)
        method = method.upper()
        allowed = (method == "GET" and canonical in READ_ONLY_GET_PATHS) or (
            method == "POST" and canonical == EXPORT_POST_PATH
        )
        if not allowed:
            raise Trading212Error(
                f"blocked non-read-only Trading 212 request: {method} {canonical}"
            )

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(max(float(retry_after), 0.0), 65.0)
            except ValueError:
                pass
        reset = response.headers.get("x-ratelimit-reset")
        if reset:
            try:
                reset_value = float(reset)
                if reset_value > 1_000_000_000_000:
                    reset_value /= 1000
                if reset_value > 1_000_000_000:
                    return min(max(reset_value - time.time(), 0.0), 65.0)
                return min(max(reset_value, 0.0), 65.0)
            except ValueError:
                pass
        # The account-summary endpoint is limited to one request every five
        # seconds. When Trading 212 omits its reset headers, a one-second first
        # retry simply burns through the remaining attempts inside the same
        # rate-limit window. Start at the documented five-second floor and
        # back off from there.
        return min(5 * (2**attempt), 30.0)

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        try:
            payload = response.json()
            detail = json.dumps(payload, ensure_ascii=False)
        except (ValueError, json.JSONDecodeError):
            detail = response.text
        return f"Trading 212 returned HTTP {response.status_code}: {' '.join(detail.split())[:500]}"

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        max_attempts: int = 6,
    ) -> Any:
        method = method.upper()
        self._assert_allowed(method, path)
        url = self._api_url(path)
        # The only allowlisted POST creates a read-only CSV export. A 429
        # explicitly means the broker did not accept that operation, so it is
        # safe to retry after the rate-limit window. Network failures and 5xx
        # responses remain single-attempt for POST because their acceptance
        # state is ambiguous.
        attempts = max_attempts
        retryable_statuses = {429} if method == "POST" else {408, 429, 500, 502, 503, 504}
        for attempt in range(attempts):
            try:
                response = self._http.request(
                    method,
                    url,
                    json=json_body,
                    auth=self._auth,
                    follow_redirects=False,
                )
            except httpx.RequestError as exc:
                if method == "POST" or attempt + 1 >= attempts:
                    raise Trading212Error(
                        f"Trading 212 request failed: {method} "
                        f"{self._canonical_path(path)} ({type(exc).__name__})"
                    ) from exc
                self._sleep(min(2**attempt, 30.0))
                continue
            if response.status_code in retryable_statuses and attempt + 1 < attempts:
                self._sleep(self._retry_delay(response, attempt))
                continue
            if response.is_error:
                raise Trading212Error(self._error_message(response))
            try:
                return response.json()
            except ValueError as exc:
                raise Trading212Error(
                    f"Trading 212 returned non-JSON data for {method} {self._canonical_path(path)}"
                ) from exc
        raise Trading212Error(
            f"Trading 212 request exhausted retries: {method} {self._canonical_path(path)}"
        )

    def account_summary(self) -> dict[str, Any]:
        payload = self._request_json("GET", "/equity/account/summary")
        if not isinstance(payload, dict):
            raise Trading212Error("account summary response was not an object")
        return payload

    def positions(self) -> list[dict[str, Any]]:
        payload = self._request_json("GET", "/equity/positions")
        if not isinstance(payload, list):
            raise Trading212Error("positions response was not a list")
        return payload

    def pending_orders(self) -> list[dict[str, Any]]:
        payload = self._request_json("GET", "/equity/orders")
        if not isinstance(payload, list):
            raise Trading212Error("pending orders response was not a list")
        return payload

    def cash_transactions(
        self,
        *,
        stop_references: frozenset[str] = frozenset(),
    ) -> list[dict[str, Any]]:
        """Fetch cash movements missing from the richer CSV ledger.

        Trading 212 paginates this endpoint newest-first and limits it to six
        requests per minute.  Existing references let routine syncs stop on
        the first overlapping page; a first installation intentionally walks
        the complete history so transfers to and from the card wallet are not
        lost from NAV reconstruction.
        """

        path = "/equity/history/transactions?limit=50"
        items: list[dict[str, Any]] = []
        visited_paths: set[str] = set()
        for page in range(500):
            if path in visited_paths:
                raise Trading212Error("cash transaction pagination repeated a cursor")
            visited_paths.add(path)
            if page:
                self._sleep(10.1)
            payload = self._request_json("GET", path, max_attempts=1)
            if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                raise Trading212Error("cash transactions response was not a paginated object")
            page_items = [item for item in payload["items"] if isinstance(item, dict)]
            overlap = any(
                str(item.get("reference") or "") in stop_references for item in page_items
            )
            items.extend(
                item
                for item in page_items
                if str(item.get("reference") or "") not in stop_references
            )
            next_path = payload.get("nextPagePath")
            if overlap or not next_path:
                return items
            text = str(next_path)
            path = (
                text if text.startswith("/") else f"/equity/history/transactions?{text.lstrip('?')}"
            )
        raise Trading212Error("cash transaction pagination exceeded 500 pages")

    def request_export(self, time_from: datetime, time_to: datetime) -> int:
        payload = self._request_json(
            "POST",
            EXPORT_POST_PATH,
            json_body={
                "dataIncluded": {
                    "includeDividends": True,
                    "includeInterest": True,
                    "includeOrders": True,
                    "includeTransactions": True,
                },
                "timeFrom": utc_iso(time_from),
                "timeTo": utc_iso(time_to),
            },
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("reportId"), int):
            raise Trading212ExportError("export request did not return an integer reportId")
        return payload["reportId"]

    def list_exports(self) -> list[dict[str, Any]]:
        payload = self._request_json("GET", "/equity/history/exports")
        if not isinstance(payload, list):
            raise Trading212ExportError("exports response was not a list")
        return payload

    def wait_for_export(
        self,
        report_id: int,
        *,
        poll_seconds: float = 65.0,
        timeout_seconds: float = 15 * 60,
    ) -> dict[str, Any]:
        deadline = self._monotonic() + timeout_seconds
        while True:
            report = next(
                (item for item in self.list_exports() if item.get("reportId") == report_id),
                None,
            )
            if report:
                status = report.get("status")
                if status == "Finished":
                    if not report.get("downloadLink"):
                        raise Trading212ExportError(
                            f"report {report_id} finished without a downloadLink"
                        )
                    return report
                if status in FINISHED_EXPORT_STATUSES:
                    raise Trading212ExportError(f"report {report_id} ended with status {status}")
            if self._monotonic() >= deadline:
                raise TimeoutError(
                    f"report {report_id} did not finish within {timeout_seconds:.0f} seconds"
                )
            self._sleep(poll_seconds)

    def download_export(self, download_link: str, destination: Path) -> Path:
        parsed = urlparse(download_link)
        if parsed.scheme != "https" or not parsed.netloc:
            raise Trading212ExportError("export downloadLink must be an HTTPS URL")
        destination = destination.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            # Signed links can point to a different storage host; never leak
            # Trading 212 Basic Auth to that host.
            with self._http.stream(
                "GET", download_link, auth=None, follow_redirects=True
            ) as response:
                if response.is_error:
                    raise Trading212ExportError(self._error_message(response))
                with temporary.open("wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)
            if not temporary.read_bytes().strip():
                # Trading 212 returns an empty HTTP 200 body for a completed
                # report window that predates the account. Normalize that
                # valid zero-row result into the same typed CSV boundary as a
                # non-empty export. Non-empty malformed files still fail the
                # strict schema check below.
                with temporary.open("w", newline="", encoding="utf-8") as handle:
                    csv.writer(handle).writerow(sorted(REQUIRED_EXPORT_COLUMNS))
            inspect_export_csv(temporary)
            temporary.replace(destination)
            with suppress(OSError):
                destination.chmod(0o600)
            return destination
        finally:
            if temporary.exists():
                temporary.unlink()

    def snapshot(self, *, include_pending_orders: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": 1,
            "fetched_at_utc": utc_iso(datetime.now(UTC)),
            "profile": self.credentials.profile,
            "environment": self.environment,
            "account_summary": self.account_summary(),
            "positions": self.positions(),
        }
        if include_pending_orders:
            payload["pending_orders"] = self.pending_orders()
        return payload


def inspect_export_csv(path: Path) -> dict[str, Any]:
    """Validate an official export and return non-sensitive file metadata."""

    try:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            columns = reader.fieldnames or []
            missing = REQUIRED_EXPORT_COLUMNS - set(columns)
            if missing:
                raise Trading212ExportError(
                    f"CSV export is missing required columns: {sorted(missing)}"
                )
            row_count = sum(1 for _ in reader)
    except UnicodeError as exc:
        raise Trading212ExportError(f"CSV export is not valid UTF-8: {path}") from exc

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "columns": columns,
        "row_count": row_count,
        "sha256": digest.hexdigest(),
        "size_bytes": path.stat().st_size,
    }


def _write_private_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    with suppress(OSError):
        temporary.chmod(0o600)
    temporary.replace(path)


class ManagedAccountStore:
    """Private state store for one broker profile."""

    def __init__(self, profile: str, *, data_root: Path | None = None) -> None:
        self.profile = _profile_token(profile)
        self.data_root = (data_root or default_data_root()).expanduser().resolve()
        self.root = self.data_root / self.profile
        self.exports_dir = self.root / "exports"
        self.snapshots_dir = self.root / "snapshots"
        self.manifest_path = self.root / "latest_export.json"
        self.pending_path = self.root / "pending_export.json"
        self.cash_transactions_path = self.root / "cash_transactions.json"
        for path in (self.root, self.exports_dir, self.snapshots_dir):
            path.mkdir(parents=True, exist_ok=True)
            with suppress(OSError):
                path.chmod(0o700)

    def export_destination(self, *, report_id: int, start: date, end: date) -> Path:
        return self.exports_dir / (
            f"from_{start.isoformat()}_to_{end.isoformat()}_t212_{self.profile}_{report_id}.csv"
        )

    def consolidated_export_destination(
        self,
        *,
        report_id: int,
        start: date,
        end: date,
    ) -> Path:
        """Return the canonical path for a deduplicated multi-report ledger."""

        return self.exports_dir / (
            f"from_{start.isoformat()}_to_{end.isoformat()}_t212_"
            f"{self.profile}_{report_id}_consolidated.csv"
        )

    def write_snapshot(self, payload: Mapping[str, Any]) -> Path:
        timestamp = str(payload.get("fetched_at_utc", "")).replace(":", "").replace("-", "")
        if not timestamp:
            timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        path = self.snapshots_dir / f"snapshot_{timestamp}.json"
        _write_private_json(path, payload)
        return path

    def save_pending(
        self,
        *,
        report_id: int,
        environment: str,
        time_from: datetime,
        time_to: datetime,
    ) -> None:
        _write_private_json(
            self.pending_path,
            {
                "schema_version": 1,
                "profile": self.profile,
                "environment": environment,
                "report_id": report_id,
                "time_from": utc_iso(time_from),
                "time_to": utc_iso(time_to),
            },
        )

    def matching_pending(
        self,
        *,
        environment: str,
        time_from: datetime,
        time_to: datetime,
    ) -> int | None:
        if not self.pending_path.is_file():
            return None
        try:
            payload = json.loads(self.pending_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        expected = (
            payload.get("profile") == self.profile
            and payload.get("environment") == environment
            and payload.get("time_from") == utc_iso(time_from)
            and str(payload.get("time_to", ""))[:10] == utc_iso(time_to)[:10]
        )
        report_id = payload.get("report_id")
        return report_id if expected and isinstance(report_id, int) else None

    def clear_pending(self) -> None:
        if self.pending_path.exists():
            self.pending_path.unlink()

    def read_cash_transactions(self) -> list[dict[str, Any]]:
        """Read the cached official cash-movement feed for this profile."""

        if not self.cash_transactions_path.is_file():
            return []
        try:
            payload = json.loads(self.cash_transactions_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise Trading212ExportError("invalid cached cash transaction history") from exc
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise Trading212ExportError("cached cash transaction history has invalid items")
        return items

    def write_cash_transactions(self, items: list[dict[str, Any]]) -> Path:
        """Persist a deduplicated, newest-first cash-movement feed."""

        deduplicated: dict[str, dict[str, Any]] = {}
        for item in items:
            reference = str(item.get("reference") or "").strip()
            if not reference:
                raise Trading212ExportError("cash transaction is missing its reference")
            deduplicated[reference] = item
        ordered = sorted(
            deduplicated.values(),
            key=lambda item: str(item.get("dateTime") or ""),
            reverse=True,
        )
        _write_private_json(
            self.cash_transactions_path,
            {"schema_version": 1, "profile": self.profile, "items": ordered},
        )
        return self.cash_transactions_path

    def register_export(
        self,
        *,
        path: Path,
        environment: str,
        report: Mapping[str, Any],
        account_summary: Mapping[str, Any],
        reconciliation: Mapping[str, Any] | ReconciliationResult,
    ) -> dict[str, Any]:
        path = path.resolve()
        try:
            relative_path = path.relative_to(self.data_root)
        except ValueError as exc:
            raise Trading212ExportError(
                "managed export must be stored below T212_DATA_DIR"
            ) from exc
        metadata = inspect_export_csv(path)
        reconciliation_payload = (
            reconciliation.model_dump(by_alias=True)
            if isinstance(reconciliation, ReconciliationResult)
            else dict(reconciliation)
        )
        manifest: dict[str, Any] = {
            "schema_version": 1,
            "profile": self.profile,
            "environment": environment,
            "updated_at_utc": utc_iso(datetime.now(UTC)),
            "account": {
                "id": account_summary.get("id"),
                "currency": account_summary.get("currency"),
            },
            "report": {
                "report_id": report.get("reportId"),
                "component_report_ids": report.get("componentReportIds", []),
                "status": report.get("status"),
                "time_from": report.get("timeFrom"),
                "time_to": report.get("timeTo"),
                "data_included": report.get("dataIncluded"),
            },
            "csv": {"path": str(relative_path), **metadata},
            "reconciliation": reconciliation_payload,
        }
        _write_private_json(self.manifest_path, manifest)
        self.clear_pending()
        return manifest


def latest_export_metadata(profile: str, *, data_root: Path | None = None) -> dict[str, Any] | None:
    root = (data_root or default_data_root()).expanduser().resolve()
    manifest_path = root / _profile_token(profile) / "latest_export.json"
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise Trading212ExportError(f"invalid manifest: {manifest_path}") from exc
    if payload.get("profile") != _profile_token(profile):
        raise Trading212ExportError(f"profile mismatch in manifest: {manifest_path}")
    return payload


def latest_export_path(profile: str, *, data_root: Path | None = None) -> Path | None:
    root = (data_root or default_data_root()).expanduser().resolve()
    payload = latest_export_metadata(profile, data_root=root)
    if payload is None:
        return None
    relative = payload.get("csv", {}).get("path")
    if not isinstance(relative, str) or not relative:
        raise Trading212ExportError("latest export manifest has no CSV path")
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise Trading212ExportError("latest export path escapes T212_DATA_DIR") from exc
    if not path.is_file():
        raise FileNotFoundError(f"managed Trading 212 export is missing: {path}")
    return path


def latest_cash_transactions_path(
    profile: str,
    *,
    data_root: Path | None = None,
) -> Path | None:
    """Return the managed official cash-movement sidecar when available."""

    root = (data_root or default_data_root()).expanduser().resolve()
    path = (root / _profile_token(profile) / "cash_transactions.json").resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise Trading212ExportError("cash transaction path escapes T212_DATA_DIR") from exc
    return path if path.is_file() else None


def _position_from_payload(payload: Mapping[str, Any]) -> BrokerPosition:
    instrument = payload.get("instrument") or {}
    wallet = payload.get("walletImpact") or {}
    broker_ticker = str(instrument.get("ticker") or "")
    ticker = broker_ticker
    if ticker.endswith("_US_EQ"):
        ticker = ticker.removesuffix("_US_EQ")
    elif ticker.endswith("l_EQ"):
        ticker = ticker.removesuffix("l_EQ").upper()
    return BrokerPosition(
        ticker=ticker,
        broker_ticker=broker_ticker,
        name=str(instrument.get("name") or ""),
        isin=str(instrument.get("isin") or ""),
        quantity=payload.get("quantity", 0),
        current_price=payload.get("currentPrice", 0),
        price_currency=str(instrument.get("currency") or "GBP"),
        current_value_gbp=wallet.get("currentValue", 0),
        total_cost_gbp=wallet.get("totalCost", 0),
        unrealized_profit_loss_gbp=wallet.get("unrealizedProfitLoss", 0),
        fx_impact_gbp=wallet.get("fxImpact"),
    )


def broker_snapshot_reconciliation(
    snapshot: BrokerSnapshot,
) -> BrokerSnapshotReconciliation:
    """Compare the two non-atomic Trading 212 valuation responses."""

    position_value = sum(
        (position.current_value_gbp for position in snapshot.positions),
        Decimal("0"),
    )
    position_delta = position_value - snapshot.account.investments_value
    position_tolerance = max(
        Decimal("0.02"),
        abs(snapshot.account.investments_value) * Decimal("0.0005"),
    )
    account_total_delta = (
        snapshot.account.cash_available
        + snapshot.account.investments_value
        - snapshot.account.total_value
    )
    account_total_tolerance = max(
        Decimal("0.02"),
        abs(snapshot.account.total_value) * Decimal("0.0005"),
    )
    return BrokerSnapshotReconciliation(
        position_value_gbp=position_value,
        investments_value_gbp=snapshot.account.investments_value,
        position_delta_gbp=position_delta,
        position_tolerance_gbp=position_tolerance,
        account_total_delta_gbp=account_total_delta,
        account_total_tolerance_gbp=account_total_tolerance,
        positions_match_investments=abs(position_delta) <= position_tolerance,
        cash_plus_investments_matches_total=(abs(account_total_delta) <= account_total_tolerance),
    )


def validate_broker_snapshot(
    snapshot: BrokerSnapshot,
    *,
    require_positions_match: bool = True,
) -> BrokerSnapshotReconciliation:
    """Validate the authoritative summary and optionally its position detail."""

    reconciliation = broker_snapshot_reconciliation(snapshot)
    checks = {
        "positions_match_investments": reconciliation.positions_match_investments,
        "cash_plus_investments_matches_total": (reconciliation.cash_plus_investments_matches_total),
    }
    failed = not reconciliation.cash_plus_investments_matches_total or (
        require_positions_match and not reconciliation.positions_match_investments
    )
    if failed:
        raise Trading212Error(
            f"{snapshot.profile}: broker snapshot reconciliation failed: {checks}; "
            f"position_delta_gbp={reconciliation.position_delta_gbp}; "
            f"position_tolerance_gbp={reconciliation.position_tolerance_gbp}; "
            f"account_total_delta_gbp={reconciliation.account_total_delta_gbp}; "
            f"account_total_tolerance_gbp={reconciliation.account_total_tolerance_gbp}"
        )
    return reconciliation


def snapshot_from_payload(
    profile: str,
    environment: str,
    payload: Mapping[str, Any],
    *,
    require_positions_match: bool = True,
) -> BrokerSnapshot:
    summary = payload.get("account_summary") or {}
    currency = str(summary.get("currency") or "")
    if currency != "GBP":
        raise Trading212Error(f"{profile}: expected GBP account currency")
    account = BrokerAccountSummary(
        account_id=(str(summary["id"]) if summary.get("id") is not None else None),
        currency=currency,
        total_value=summary.get("totalValue", 0),
        cash_available=(summary.get("cash") or {}).get("availableToTrade", 0),
        investments_value=(summary.get("investments") or {}).get("currentValue", 0),
        investments_cost=(summary.get("investments") or {}).get("totalCost", 0),
        realized_profit_loss=(summary.get("investments") or {}).get("realizedProfitLoss", 0),
        unrealized_profit_loss=(summary.get("investments") or {}).get("unrealizedProfitLoss", 0),
    )
    raw_positions = payload.get("positions", [])
    if not isinstance(raw_positions, list):
        raise Trading212Error(f"{profile}: broker positions payload was not a list")
    positions = [_position_from_payload(item) for item in raw_positions]
    snapshot = BrokerSnapshot(
        profile=profile,
        environment=environment,
        fetched_at=_utc(
            payload.get("fetched_at") or payload.get("fetched_at_utc") or datetime.now(UTC)
        ),
        account=account,
        positions=positions,
    )
    validate_broker_snapshot(
        snapshot,
        require_positions_match=require_positions_match,
    )
    return snapshot


def _quantity(value: object) -> Decimal:
    return _decimal(value)


def reconcile_positions(
    ledger_rows: Iterable[Mapping[str, object]],
    api_positions: Iterable[BrokerPosition | Mapping[str, object]],
    *,
    tolerance: Decimal = Decimal("0.0000001"),
    coverage: Literal[
        "complete",
        "incomplete",
        "unsupported_corporate_action",
    ] = "complete",
    coverage_note: str = "",
) -> ReconciliationResult:
    """Compare a deduplicated export ledger with live broker positions.

    ``coverage`` is deliberately explicit. A matching rolling export is not
    proof of a complete opening balance, and an unsupported corporate action
    must never be silently treated as a clean reconciliation.
    """

    unique_rows: dict[tuple[str, ...], Mapping[str, object]] = {}
    for row in ledger_rows:
        identifier = str(row.get("ID") or "").strip()
        key = (
            ("id", identifier)
            if identifier
            else (
                "row",
                str(row.get("Action") or ""),
                str(row.get("Time (UTC)") or ""),
                str(row.get("ISIN") or ""),
                str(row.get("Ticker") or ""),
                str(row.get("No. of shares") or ""),
                str(row.get("Total") or ""),
            )
        )
        previous = unique_rows.get(key)
        if previous is not None and previous != row:
            raise Trading212Error(f"conflicting transaction rows for {key[-1]}")
        unique_rows[key] = row

    ledger: dict[str, Decimal] = {}
    labels: dict[str, str] = {}
    for row in unique_rows.values():
        action = str(row.get("Action") or "").strip().lower()
        quantity = _quantity(row.get("No. of shares"))
        isin = str(row.get("ISIN") or "").strip().upper()
        ticker = str(row.get("Ticker") or "").strip().upper()
        identity = f"isin:{isin}" if isin else f"ticker:{ticker}"
        if identity.endswith(":") or not quantity:
            continue
        if "sell" in action or action == "stock split close":
            delta = -quantity
        elif "buy" in action or action == "stock split open":
            delta = quantity
        else:
            continue
        ledger[identity] = ledger.get(identity, Decimal("0")) + delta
        labels[identity] = ticker or isin

    actual: dict[str, Decimal] = {}
    for position in api_positions:
        if isinstance(position, BrokerPosition):
            isin = position.isin.upper()
            ticker = position.ticker.upper()
            quantity = position.quantity
        else:
            instrument = position.get("instrument") or {}
            isin = str(instrument.get("isin") or "").strip().upper()
            ticker = (
                str(instrument.get("shortName") or instrument.get("ticker") or "").strip().upper()
            )
            quantity = _quantity(position.get("quantity"))
        identity = f"isin:{isin}" if isin else f"ticker:{ticker}"
        if identity.endswith(":"):
            continue
        actual[identity] = actual.get(identity, Decimal("0")) + quantity
        labels[identity] = ticker or isin

    differences: list[ReconciliationDifference] = []
    for identity in sorted(set(ledger) | set(actual)):
        ledger_quantity = ledger.get(identity, Decimal("0"))
        api_quantity = actual.get(identity, Decimal("0"))
        # A bounded export can legitimately contain only the sale of a
        # position opened before the window. If that instrument is now absent
        # from the live portfolio, its negative rolling-ledger balance does not
        # contradict current positions. Positive residuals and every live
        # position still require an exact match.
        if api_quantity == 0 and ledger_quantity < 0:
            continue
        delta = api_quantity - ledger_quantity
        if abs(delta) <= tolerance:
            continue
        differences.append(
            ReconciliationDifference(
                instrument=labels.get(identity, identity),
                identity=identity,
                ledger_quantity=ledger_quantity,
                api_quantity=api_quantity,
                delta=delta,
            )
        )
    status = (
        "unverified" if coverage != "complete" else "verified" if not differences else "mismatch"
    )
    if coverage != "complete":
        default_note = (
            "Reconciliation is unverified because the opening ledger coverage is incomplete."
            if coverage == "incomplete"
            else "Reconciliation is unverified because a corporate action is not "
            "supported by the covered ledger."
        )
        note = coverage_note.strip() or default_note
        if differences:
            note += " Live positions also differ from the covered ledger."
    else:
        note = (
            "CSV-derived quantities match the live positions endpoint."
            if not differences
            else "The ledger and live positions differ; inspect coverage or corporate actions."
        )
    return ReconciliationResult(
        status=status,
        coverage=coverage,
        checked_at=datetime.now(UTC),
        tolerance=tolerance,
        ledger_instruments=len([value for value in ledger.values() if value]),
        api_instruments=len(actual),
        differences=differences,
        note=note,
    )


def reconcile_csv_files(
    csv_paths: Path | Iterable[Path],
    api_positions: Iterable[BrokerPosition | Mapping[str, object]],
    *,
    coverage: Literal[
        "complete",
        "incomplete",
        "unsupported_corporate_action",
    ] = "complete",
    coverage_note: str = "",
) -> ReconciliationResult:
    paths = (csv_paths,) if isinstance(csv_paths, Path) else tuple(Path(p) for p in csv_paths)
    if not paths:
        raise Trading212Error("at least one Trading 212 export is required")
    rows: list[dict[str, str]] = []
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(f"missing Trading 212 export: {path}")
        with path.open(newline="", encoding="utf-8-sig") as handle:
            rows.extend(csv.DictReader(handle))
    return reconcile_positions(
        rows,
        api_positions,
        coverage=coverage,
        coverage_note=coverage_note,
    )


def merge_export_csv_files(
    csv_paths: Iterable[Path],
    destination: Path,
) -> Path:
    """Merge overlapping official exports into one private canonical ledger.

    Trading 212 limits each report to at most one year.  A complete local
    ledger therefore consists of multiple overlapping reports.  Immutable
    transaction IDs are the primary deduplication key; rows without an ID use
    their complete official-export row as the fallback identity.
    """

    paths = tuple(dict.fromkeys(Path(path).expanduser().resolve() for path in csv_paths))
    if not paths:
        raise Trading212ExportError("at least one Trading 212 export is required")

    columns: list[str] = []
    rows_by_key: dict[tuple[str, ...], dict[str, str]] = {}
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(f"missing Trading 212 export: {path}")
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            fieldnames = reader.fieldnames or []
            missing = REQUIRED_EXPORT_COLUMNS - set(fieldnames)
            if missing:
                raise Trading212ExportError(
                    f"CSV export is missing required columns: {sorted(missing)}"
                )
            for column in fieldnames:
                if column not in columns:
                    columns.append(column)
            for row in reader:
                identifier = str(row.get("ID") or "").strip()
                key = (
                    ("id", identifier)
                    if identifier
                    else ("row", *(str(row.get(column) or "") for column in fieldnames))
                )
                normalized = {str(column): str(value or "") for column, value in row.items()}
                previous = rows_by_key.get(key)
                if previous is not None and previous != normalized:
                    raise Trading212ExportError(
                        f"conflicting transaction rows for export identity {key[-1]}"
                    )
                rows_by_key[key] = normalized

    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    ordered_rows = sorted(
        rows_by_key.values(),
        key=lambda row: (str(row.get("Time (UTC)") or ""), str(row.get("ID") or "")),
    )
    try:
        with temporary.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(ordered_rows)
        inspect_export_csv(temporary)
        with suppress(OSError):
            temporary.chmod(0o600)
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


__all__ = [
    "API_BASE_URLS",
    "BrokerAccountSummary",
    "BrokerPosition",
    "BrokerSnapshot",
    "BrokerSnapshotReconciliation",
    "ManagedAccountStore",
    "ReconciliationDifference",
    "ReconciliationResult",
    "Trading212Client",
    "Trading212Credentials",
    "Trading212CredentialsError",
    "Trading212Error",
    "Trading212ExportError",
    "broker_snapshot_reconciliation",
    "default_data_root",
    "export_window",
    "inspect_export_csv",
    "latest_cash_transactions_path",
    "latest_export_metadata",
    "latest_export_path",
    "merge_export_csv_files",
    "reconcile_csv_files",
    "reconcile_positions",
    "snapshot_from_payload",
    "utc_iso",
    "validate_broker_snapshot",
]
