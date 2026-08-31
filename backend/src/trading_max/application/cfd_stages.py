"""Publish imported CFD ledger, realised analysis, and money-proxy history."""

from __future__ import annotations

import csv
import io
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from trading_max.analytics.cfd import CfdAnalysis, CfdEvent, CfdLedger, analyse_cfd_ledger
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.ingestion.cfd_imports import CfdImportStore

from .errors import StageExecutionError
from .stages import StageContext, StageResult


def _closed_after_fx(event: CfdEvent) -> Decimal:
    if event.result_after_fx_fee is not None:
        return event.result_after_fx_fee
    return (event.gross_result or Decimal(0)) + (event.fx_fee or Decimal(0))


def _transfer_profile(event: CfdEvent) -> str | None:
    info = (event.info or "").strip().casefold()
    if "stocks isa" in info or " isa " in f" {info} ":
        return "isa"
    if "invest" in info:
        return "invest"
    return None


def _daily_proxy_csv(
    ledger: CfdLedger,
    analysis: CfdAnalysis,
    account_external_flows: dict[str, dict[str, Decimal]],
) -> tuple[str, tuple[str, ...]]:
    events = {event.event_id: event for event in ledger.events}
    standalone_overnight = {
        event.position_id
        for event in ledger.events
        if event.record_type == "Overnight interest" and event.position_id
    }
    standalone_dividend = {
        event.position_id
        for event in ledger.events
        if event.record_type == "Dividend adjustment" and event.position_id
    }
    household_external = Decimal(0)
    cumulative_closed_after_fx = Decimal(0)
    cumulative_overnight = Decimal(0)
    cumulative_dividend = Decimal(0)
    cumulative_internal_transfer = Decimal(0)
    cumulative_matched_internal_transfer = Decimal(0)
    cumulative_unmatched_internal_transfer = Decimal(0)
    unverified_transfer_count = 0
    transfer_totals: dict[tuple[str, str], Decimal] = {}
    unknown_transfer_dates: set[str] = set()
    for event in ledger.events:
        if event.record_type != "Transaction" or event.transaction_type != "Transfer":
            continue
        date = event.occurred_at.date().isoformat()
        profile = _transfer_profile(event)
        if profile is None:
            unknown_transfer_dates.add(date)
            continue
        identity = (date, profile)
        transfer_totals[identity] = transfer_totals.get(identity, Decimal(0)) + (
            event.amount or Decimal(0)
        )
    matched_transfers: set[tuple[str, str]] = set()
    warnings: list[str] = []
    for (date, profile), transfer in sorted(transfer_totals.items()):
        counterpart = account_external_flows.get(profile, {}).get(date, Decimal(0))
        if transfer != 0 and counterpart != 0 and abs(transfer + counterpart) <= Decimal("0.01"):
            matched_transfers.add((date, profile))
        else:
            warnings.append(
                f"CFD internal transfer on {date} could not be matched exactly to the {profile} "
                "account flow; it was included as a labelled household-internal counterflow but "
                "remains unverified"
            )
    warnings.extend(
        f"CFD internal transfer on {date} has no recognized Invest/ISA counter-account; "
        "it was not used as a household contribution counterflow"
        for date in sorted(unknown_transfer_dates)
    )
    rows: dict[str, dict[str, str]] = {}
    for point in analysis.realised_series:
        event = events[point.event_id]
        if event.record_type == "Transaction" and event.transaction_type in {
            "Deposit",
            "Withdrawal",
        }:
            household_external += event.amount or Decimal(0)
        elif event.record_type == "Transaction" and event.transaction_type == "Transfer":
            profile = _transfer_profile(event)
            identity = (point.occurred_at.date().isoformat(), profile or "")
            amount = event.amount or Decimal(0)
            if profile is not None:
                # Trading 212 explicitly labels the counter-account in Info.
                # That broker classification is authoritative for the household
                # boundary; exact dated account-flow matching only controls the
                # verification status.
                cumulative_internal_transfer += amount
            if identity in matched_transfers:
                # The Invest/ISA NAV ledger records the other end as an account
                # external flow. The CFD-side amount cancels it at the household
                # boundary.
                cumulative_matched_internal_transfer += amount
            else:
                cumulative_unmatched_internal_transfer += amount
                unverified_transfer_count += 1
        elif event.record_type == "Closed position":
            cumulative_closed_after_fx += _closed_after_fx(event)
            position_id = event.position_id or ""
            if position_id not in standalone_overnight:
                cumulative_overnight += event.embedded_overnight_interest or Decimal(0)
            if position_id not in standalone_dividend:
                cumulative_dividend += event.embedded_dividend_adjustment or Decimal(0)
        elif event.record_type == "Overnight interest":
            cumulative_overnight += event.amount or Decimal(0)
        elif event.record_type == "Dividend adjustment":
            cumulative_dividend += event.dividend_net or Decimal(0)
        date = point.occurred_at.date().isoformat()
        rows[date] = {
            "Date": date,
            "NavQuality": "realised_cash_equity_proxy",
            "TrueNavAvailable": "false",
            # Compatibility column for older readers. The schema and quality
            # fields explicitly identify this as a realised proxy, not NAV.
            "SyntheticNAVGBP": str(point.realised_cash_equity_proxy),
            "RealisedCashEquityProxyGBP": str(point.realised_cash_equity_proxy),
            "CumulativeAccountCashFlowGBP": str(point.cumulative_account_cash_flow),
            "CumulativeHouseholdExternalFlowGBP": str(household_external),
            "CumulativeInternalTransferCounterflowGBP": str(cumulative_internal_transfer),
            "CumulativeMatchedInternalTransferCounterflowGBP": str(
                cumulative_matched_internal_transfer
            ),
            "CumulativeUnmatchedInternalTransferGBP": str(cumulative_unmatched_internal_transfer),
            "HouseholdTransferMatchStatus": (
                "verified" if unverified_transfer_count == 0 else "partial"
            ),
            "CumulativeRealisedPnLGBP": str(point.cumulative_realised_pnl),
            "RealisedPnLDrawdownGBP": str(point.realised_pnl_drawdown),
            "CumulativeClosedAfterFXGBP": str(cumulative_closed_after_fx),
            "CumulativeOvernightInterestGBP": str(cumulative_overnight),
            "CumulativeDividendAdjustmentGBP": str(cumulative_dividend),
        }
    fieldnames = [
        "Date",
        "NavQuality",
        "TrueNavAvailable",
        "SyntheticNAVGBP",
        "RealisedCashEquityProxyGBP",
        "CumulativeAccountCashFlowGBP",
        "CumulativeHouseholdExternalFlowGBP",
        "CumulativeInternalTransferCounterflowGBP",
        "CumulativeMatchedInternalTransferCounterflowGBP",
        "CumulativeUnmatchedInternalTransferGBP",
        "HouseholdTransferMatchStatus",
        "CumulativeRealisedPnLGBP",
        "RealisedPnLDrawdownGBP",
        "CumulativeClosedAfterFXGBP",
        "CumulativeOvernightInterestGBP",
        "CumulativeDividendAdjustmentGBP",
    ]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows[date] for date in sorted(rows))
    return buffer.getvalue(), tuple(dict.fromkeys(warnings))


def _metrics_payload(
    ledger: CfdLedger,
    analysis: CfdAnalysis,
    import_status: dict[str, Any],
    warnings: tuple[str, ...],
) -> dict[str, Any]:
    pnl = analysis.realised_pnl
    cash = analysis.cash_flows
    ending_proxy = (
        analysis.realised_series[-1].realised_cash_equity_proxy
        if analysis.realised_series
        else Decimal(0)
    )
    return {
        "schema_version": 1,
        "calculation_version": analysis.calculation_version,
        "parser_version": ledger.parser_version,
        "nav_quality": "realised_cash_equity_proxy",
        "true_nav_available": False,
        "source": "manual_trading212_cfd_csv",
        "start": ledger.coverage_start.isoformat() if ledger.coverage_start else None,
        "end": ledger.coverage_end.isoformat() if ledger.coverage_end else None,
        "last_event_date": ledger.latest_event_at.isoformat() if ledger.latest_event_at else None,
        "ending_nav_gbp": str(ending_proxy),
        "net_external_flows_gbp": str(cash.household_external_flow),
        "account_cash_flows_gbp": str(cash.account_cash_flow),
        "realized_profit_loss_gbp": str(pnl.net_realised_pnl),
        "closed_gross_pnl_gbp": str(pnl.closed_gross_result),
        "fx_fees_gbp": str(pnl.fx_fees),
        "closed_after_fx_pnl_gbp": str(pnl.closed_after_fx),
        "overnight_charges_gbp": str(pnl.overnight_interest),
        "dividend_adjustments_gbp": str(pnl.dividend_adjustment),
        "financing_to_gross_ratio": (
            str(pnl.financing_drag_to_gross_ratio)
            if pnl.financing_drag_to_gross_ratio is not None
            else None
        ),
        "financing_to_net_ratio": (
            str(pnl.financing_drag_to_net_ratio)
            if pnl.financing_drag_to_net_ratio is not None
            else None
        ),
        "closed_positions": analysis.trade_quality.trade_count,
        "max_drawdown_gbp": str(pnl.max_realised_pnl_drawdown),
        "pnl_sharpe_proxy": None,
        "reconciliation_gap_gbp": "0",
        "reconciliation_status": "verified_canonical_ledger",
        "warning": " ".join(warnings),
        "import_status": import_status,
    }


class CfdAccountStage:
    """Consume private imports without making CFD mandatory for other users."""

    name = "accounts.cfd"
    version = "cfd-account-v1"
    required_for = frozenset({"all", "accounts", "cfd"})
    # Normal account plans supply current NAV artifacts. The isolated CFD plan
    # deliberately reads the same keys from the latest immutable snapshot.
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
    ) -> None:
        self.imports = CfdImportStore(state_root)
        self.artifacts = artifacts
        self.snapshots = SnapshotStore(state_root)

    def _nav_artifact(self, context: StageContext, key: str):
        for artifact_id in reversed(context.upstream_artifact_ids):
            try:
                candidate = self.artifacts.get_bytes(artifact_id)
            except (FileNotFoundError, RuntimeError):
                continue
            if candidate.ref.key == key:
                return candidate
        if context.scope == "cfd":
            previous = self.snapshots.latest()
            if previous is not None:
                ref = next((item for item in previous.manifest.artifacts if item.key == key), None)
                if ref is not None:
                    try:
                        return self.artifacts.get_bytes(ref.artifact_id)
                    except (FileNotFoundError, RuntimeError):
                        pass
        raise StageExecutionError(
            "account.cfd_nav_dependency_missing",
            f"missing upstream artifact {key}",
        )

    def _account_external_flows(self, context: StageContext) -> dict[str, dict[str, Decimal]]:
        result: dict[str, dict[str, Decimal]] = {}
        for profile, code in (("invest", "a"), ("isa", "b")):
            key = f"account/nav/daily_nav_{code}.csv"
            stored = self._nav_artifact(context, key)
            rows = csv.DictReader(io.StringIO(stored.path.read_text(encoding="utf-8")))
            flows: dict[str, Decimal] = {}
            for row in rows:
                date = str(row.get("Date") or "").strip()
                value = str(row.get("ExternalFlowGBP") or "0").strip() or "0"
                try:
                    flows[date] = Decimal(value)
                except (InvalidOperation, ValueError) as exc:
                    raise StageExecutionError(
                        "account.cfd_nav_dependency_invalid",
                        f"{key} contains an invalid ExternalFlowGBP value",
                    ) from exc
            result[profile] = flows
        return result

    def run(self, context: StageContext) -> StageResult:
        try:
            ledger = self.imports.build_ledger()
            status = self.imports.status()
        except Exception as exc:
            raise StageExecutionError("account.cfd_import_invalid", str(exc)) from exc
        if ledger is None:
            return StageResult(metadata={"cfd_imported": False})
        try:
            analysis = analyse_cfd_ledger(ledger)
        except Exception as exc:
            raise StageExecutionError("account.cfd_analysis_failed", str(exc)) from exc
        if analysis is None:
            raise StageExecutionError(
                "account.cfd_analysis_missing",
                "the CFD ledger exists but its analysis is unavailable",
            )

        account_external_flows = self._account_external_flows(context)
        nav_csv, transfer_warnings = _daily_proxy_csv(
            ledger,
            analysis,
            account_external_flows,
        )
        warnings = list(dict.fromkeys([*ledger.warnings, *analysis.warnings, *transfer_warnings]))
        as_of = ledger.coverage_end.date().isoformat() if ledger.coverage_end else None
        ledger_artifact = self.artifacts.put_json(
            key="account/cfd_ledger.json",
            payload=ledger.to_dict(),
            kind="cfd_ledger",
            as_of=as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status="warning",
                coverage=f"{len(ledger.events)} unique events",
                warnings=warnings,
            ),
        )
        analysis_artifact = self.artifacts.put_json(
            key="account/cfd_analysis.json",
            payload={**analysis.to_dict(), "warnings": warnings, "import_status": status},
            kind="cfd_analysis",
            as_of=as_of,
            producer_version=self.version,
            dependency_artifact_ids=[ledger_artifact.ref.artifact_id],
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{analysis.trade_quality.trade_count} closed trades",
                warnings=warnings,
            ),
        )
        metrics_artifact = self.artifacts.put_json(
            key="account/cfd_metrics.json",
            payload=_metrics_payload(ledger, analysis, status, tuple(warnings)),
            kind="cfd_metrics",
            as_of=as_of,
            producer_version=self.version,
            dependency_artifact_ids=[analysis_artifact.ref.artifact_id],
            quality=analysis_artifact.ref.quality,
        )
        nav_artifact = self.artifacts.put_bytes(
            key="account/nav/daily_nav_c.csv",
            content=nav_csv.encode("utf-8"),
            kind="cfd_realised_cash_equity_proxy",
            media_type="text/csv",
            as_of=as_of,
            producer_version=self.version,
            dependency_artifact_ids=[analysis_artifact.ref.artifact_id],
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{len(analysis.realised_series)} realised event points",
                warnings=[
                    "realised cash-equity proxy excludes open-position MTM and true broker equity",
                    *warnings,
                ],
            ),
        )
        return StageResult(
            artifacts=(
                ledger_artifact.ref,
                analysis_artifact.ref,
                metrics_artifact.ref,
                nav_artifact.ref,
            ),
            warnings=tuple(warnings),
            metadata={"cfd_imported": True},
        )


__all__ = ["CfdAccountStage"]
