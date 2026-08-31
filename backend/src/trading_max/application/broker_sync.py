"""Application use case for a strict, read-only Trading 212 sync.

The use case owns orchestration; the broker adapter owns HTTP and CSV details.
Keeping this boundary here means the durable worker can call one typed
operation without importing a command-line compatibility layer or parsing
stdout.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

from trading_max.domain import DomainModel
from trading_max.ingestion.brokers.trading212 import (
    BrokerSnapshot,
    ManagedAccountStore,
    ReconciliationResult,
    Trading212Client,
    Trading212Credentials,
    Trading212Error,
    broker_snapshot_reconciliation,
    export_window,
    inspect_export_csv,
    latest_export_metadata,
    latest_export_path,
    merge_export_csv_files,
    reconcile_csv_files,
    snapshot_from_payload,
    utc_iso,
    validate_broker_snapshot,
)


class BrokerSyncRequest(DomainModel):
    """Inputs for one deterministic account sync."""

    profile: str
    environment: str = "live"
    export_start: date
    export_end: date
    include_pending_orders: bool = False
    strict_reconcile: bool = True
    coverage: Literal[
        "complete",
        "incomplete",
        "unsupported_corporate_action",
    ] = "complete"
    coverage_note: str = ""
    history_floor: date = date(2016, 1, 1)
    complete_history: bool = True


class BrokerSyncResult(DomainModel):
    """Durable outputs from a successful broker sync."""

    profile: str
    environment: str
    snapshot_path: str
    export_path: str
    snapshot: BrokerSnapshot
    reconciliation: ReconciliationResult


class _Client(Protocol):
    def __enter__(self) -> _Client: ...

    def __exit__(self, *_: object) -> None: ...

    def snapshot(self, *, include_pending_orders: bool = False) -> dict: ...

    def request_export(self, time_from, time_to) -> int: ...

    def wait_for_export(self, report_id: int) -> dict: ...

    def download_export(self, download_link: str, destination: Path) -> Path: ...

    def cash_transactions(
        self,
        *,
        stop_references: frozenset[str] = frozenset(),
    ) -> list[dict]: ...


class Trading212BrokerSync:
    """Sync one account and fail before registration on reconciliation errors."""

    def __init__(
        self,
        *,
        credentials_factory: Callable[
            [str], Trading212Credentials
        ] = Trading212Credentials.from_sources,
        client_factory: Callable[[Trading212Credentials, str], _Client] | None = None,
        store_factory: Callable[[str], ManagedAccountStore] = ManagedAccountStore,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.credentials_factory = credentials_factory
        self.client_factory = client_factory or (
            lambda credentials, environment: Trading212Client(credentials, environment=environment)
        )
        self.store_factory = store_factory
        self.sleep = sleep

    @staticmethod
    def _existing_export(
        store: ManagedAccountStore,
        request: BrokerSyncRequest,
    ) -> tuple[Path | None, date | None, list[int]]:
        metadata = latest_export_metadata(request.profile, data_root=store.data_root)
        if metadata is None or metadata.get("environment") != request.environment:
            return None, None, []
        reconciliation = metadata.get("reconciliation") or {}
        if reconciliation.get("status") != "verified":
            return None, None, []
        path = latest_export_path(request.profile, data_root=store.data_root)
        report = metadata.get("report") or {}
        time_from = str(report.get("time_from") or "")
        try:
            start = date.fromisoformat(time_from[:10])
        except ValueError:
            start = None
        report_ids = [
            value
            for value in (report.get("component_report_ids") or [report.get("report_id")])
            if isinstance(value, int)
        ]
        return path, start, report_ids

    @staticmethod
    def _download_window(
        *,
        client: _Client,
        store: ManagedAccountStore,
        environment: str,
        start_date: date,
        end_date: date,
    ) -> tuple[Path, dict, int]:
        time_from, time_to = export_window(start_date, end_date)
        mutable_window = end_date >= datetime.now(UTC).date()
        cached = (
            []
            if mutable_window
            else sorted(
                path
                for path in store.exports_dir.glob(
                    f"from_{start_date.isoformat()}_to_{end_date.isoformat()}_t212_"
                    f"{store.profile}_*.csv"
                )
                if not path.stem.endswith("_consolidated")
            )
        )
        for candidate in reversed(cached):
            try:
                inspect_export_csv(candidate)
                cached_report_id = int(candidate.stem.rsplit("_", 1)[-1])
            except (Trading212Error, ValueError):
                continue
            return (
                candidate,
                {
                    "reportId": cached_report_id,
                    "status": "Finished",
                    "timeFrom": utc_iso(time_from),
                    "timeTo": utc_iso(time_to),
                    "dataIncluded": "cached_official_export",
                },
                cached_report_id,
            )
        report_id = store.matching_pending(
            environment=environment,
            time_from=time_from,
            time_to=time_to,
        )
        if report_id is not None and mutable_window:
            downloaded = store.export_destination(
                report_id=report_id,
                start=start_date,
                end=end_date,
            )
            if downloaded.is_file():
                store.clear_pending()
                report_id = None
        if report_id is None:
            report_id = client.request_export(time_from, time_to)
            store.save_pending(
                report_id=report_id,
                environment=environment,
                time_from=time_from,
                time_to=time_to,
            )
        report = client.wait_for_export(report_id)
        destination = store.export_destination(
            report_id=report_id,
            start=start_date,
            end=end_date,
        )
        client.download_export(report["downloadLink"], destination)
        store.clear_pending()
        return destination, report, report_id

    def sync(self, request: BrokerSyncRequest) -> BrokerSyncResult:
        export_window(request.export_start, request.export_end)
        if request.history_floor > request.export_start:
            raise ValueError("history floor cannot be after export start")
        credentials = self.credentials_factory(request.profile)
        store = self.store_factory(request.profile)

        with self.client_factory(credentials, request.environment) as client:
            raw_snapshot = client.snapshot(include_pending_orders=request.include_pending_orders)
            snapshot = snapshot_from_payload(
                request.profile,
                request.environment,
                raw_snapshot,
            )

            cash_reader = getattr(client, "cash_transactions", None)
            cash_transactions: list[dict] | None = None
            if callable(cash_reader):
                cached_cash_transactions = store.read_cash_transactions()
                known_references = frozenset(
                    str(item.get("reference") or "")
                    for item in cached_cash_transactions
                    if item.get("reference")
                )
                new_cash_transactions = cash_reader(
                    stop_references=known_references,
                )
                cash_transactions = [*new_cash_transactions, *cached_cash_transactions]

            existing_path, existing_start, component_report_ids = self._existing_export(
                store,
                request,
            )
            current_path, report, report_id = self._download_window(
                client=client,
                store=store,
                environment=request.environment,
                start_date=request.export_start,
                end_date=request.export_end,
            )
            component_report_ids.append(report_id)
            export_paths = [path for path in (existing_path, current_path) if path is not None]
            oldest_start = min(
                start for start in (existing_start, request.export_start) if start is not None
            )
            reconciliation = reconcile_csv_files(
                export_paths,
                snapshot.positions,
                coverage=request.coverage,
                coverage_note=request.coverage_note,
            )

            # Trading 212 rejects any single export spanning more than one
            # year.  Position reconciliation alone is not enough for a
            # performance ledger: fully closed campaigns and old cash flows
            # disappear from the live holdings check.  A complete sync must
            # therefore walk every yearly slice to the configured history
            # floor. Existing consolidated history makes later runs cheap.
            while (
                request.coverage == "complete"
                and (reconciliation.status == "mismatch" or request.complete_history)
                and oldest_start > request.history_floor
            ):
                older_end = oldest_start - timedelta(days=1)
                older_start = max(
                    request.history_floor,
                    older_end - timedelta(days=364),
                )
                older_path, _older_report, older_report_id = self._download_window(
                    client=client,
                    store=store,
                    environment=request.environment,
                    start_date=older_start,
                    end_date=older_end,
                )
                export_paths.append(older_path)
                component_report_ids.append(older_report_id)
                oldest_start = older_start
                if inspect_export_csv(older_path)["row_count"] == 0:
                    # The immediately preceding annual window is empty, so
                    # the consolidated ledger has crossed account inception.
                    # Keep the zero-row component as auditable coverage and
                    # stop creating older reports.
                    break
                reconciliation = reconcile_csv_files(
                    export_paths,
                    snapshot.positions,
                    coverage=request.coverage,
                    coverage_note=request.coverage_note,
                )

            if request.strict_reconcile and reconciliation.status != "verified":
                raise Trading212Error(
                    f"{request.profile}: strict broker reconciliation failed: "
                    f"{reconciliation.status}"
                )

            # The live snapshot and incremental cash feed must move forward
            # only with a verified ledger boundary. Otherwise a failed strict
            # sync can become the next run's apparent latest state even though
            # no immutable snapshot was published.
            snapshot_path = store.write_snapshot(raw_snapshot)
            if cash_transactions is not None:
                store.write_cash_transactions(cash_transactions)

            destination = store.consolidated_export_destination(
                report_id=report_id,
                start=oldest_start,
                end=request.export_end,
            )
            merge_export_csv_files(export_paths, destination)
            aggregate_report = {
                **report,
                "componentReportIds": list(dict.fromkeys(component_report_ids)),
                "timeFrom": utc_iso(
                    datetime.combine(oldest_start, datetime.min.time(), tzinfo=UTC)
                ),
            }
            store.register_export(
                path=destination,
                environment=request.environment,
                report=aggregate_report,
                account_summary=raw_snapshot["account_summary"],
                reconciliation=reconciliation,
            )

        return BrokerSyncResult(
            profile=request.profile,
            environment=request.environment,
            snapshot_path=str(snapshot_path),
            export_path=str(destination),
            snapshot=snapshot,
            reconciliation=reconciliation,
        )

    def snapshot_only(
        self,
        profile: str,
        *,
        environment: str = "live",
        include_pending_orders: bool = False,
        allow_unreconciled_positions: bool = False,
        reconciliation_attempts: int = 1,
        reconciliation_retry_seconds: float = 5.0,
    ) -> dict:
        """Fetch and persist the broker valuation without starting an export.

        This is intentionally a separate operation from :meth:`sync`: the
        ten-minute path needs a current account value, but an asynchronous
        history export is too expensive and can block the full pipeline.  The
        resulting snapshot is therefore a broker-value observation only; the
        daily export remains the authoritative cash-flow source.
        """

        if reconciliation_attempts < 1:
            raise ValueError("reconciliation_attempts must be at least one")
        if reconciliation_retry_seconds < 0:
            raise ValueError("reconciliation_retry_seconds cannot be negative")

        credentials = self.credentials_factory(profile)
        store = self.store_factory(profile)
        with self.client_factory(credentials, environment) as client:
            for attempt in range(reconciliation_attempts):
                raw_snapshot = client.snapshot(
                    include_pending_orders=include_pending_orders,
                )
                snapshot = snapshot_from_payload(
                    profile,
                    environment,
                    raw_snapshot,
                    require_positions_match=False,
                )
                reconciliation = broker_snapshot_reconciliation(snapshot)
                if reconciliation.positions_match_investments:
                    break
                if attempt + 1 < reconciliation_attempts:
                    self.sleep(reconciliation_retry_seconds)
                    continue
                if not allow_unreconciled_positions:
                    validate_broker_snapshot(snapshot)
            store.write_snapshot(raw_snapshot)
        return raw_snapshot


__all__ = ["BrokerSyncRequest", "BrokerSyncResult", "Trading212BrokerSync"]
