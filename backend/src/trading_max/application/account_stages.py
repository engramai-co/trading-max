"""Typed account stages consuming the private broker state root."""

from __future__ import annotations

from pathlib import Path

from trading_max.analytics.accounts import (
    intraday_account_value,
    metrics_from_snapshot_file,
)
from trading_max.analytics.ledger import load_transactions, policy_metrics
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.ingestion.brokers.trading212 import latest_export_path

from .errors import StageExecutionError
from .stages import StageContext, StageResult


class AccountSnapshotStage:
    """Normalize Invest and ISA snapshots into one versioned account artifact."""

    name = "accounts.snapshot"
    version = "accounts-v2"
    required_for = frozenset({"all", "accounts", "intraday"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        profiles: tuple[tuple[str, str], ...] = (("A", "invest"), ("B", "isa")),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.profiles = profiles

    def _latest_snapshot(self, profile: str) -> Path:
        roots = (
            self.state_root / "trading212",
            self.state_root / "raw" / "trading212",
            self.state_root,
        )
        candidates = [
            path
            for root in roots
            if root.is_dir()
            for path in root.glob(f"{profile}/snapshots/snapshot_*.json")
        ]
        if not candidates:
            raise StageExecutionError(
                "account.snapshot_missing",
                f"no private Trading 212 snapshot for profile {profile}",
            )
        candidates.sort(key=lambda path: path.name)
        return candidates[-1]

    def run(self, context: StageContext) -> StageResult:
        intraday = context.scope == "intraday" or context.trigger == "intraday"
        accounts: dict[str, dict] = {}
        artifact_refs = []
        warnings: list[str] = []
        for account_code, profile in self.profiles:
            path = self._latest_snapshot(profile)
            try:
                metrics = metrics_from_snapshot_file(
                    profile,
                    path,
                    require_positions_match=not intraday,
                )
            except Exception as exc:
                raise StageExecutionError(
                    "account.snapshot_invalid",
                    f"{profile}: {exc}",
                ) from exc
            account_warnings: list[str] = []
            if intraday:
                observation = intraday_account_value(metrics)
                # Position detail is publishable only when it reconciles to
                # the broker-authoritative Account Summary investment value.
                # Excluding ``None`` keeps older summary-only consumers and
                # unreconciled payloads on the existing wire shape.
                payload = observation.model_dump(
                    mode="json",
                    by_alias=False,
                    exclude_none=True,
                )
                key = f"account/intraday/{profile}.json"
                kind = "account_intraday_value"
                coverage = "broker_account_summary"
                if observation.positions_status == "unreconciled":
                    warning = (
                        f"{profile}: broker position detail differs from the account summary "
                        f"by GBP {observation.position_delta_gbp}; total_value_gbp remains "
                        "broker-summary authoritative and prior verified position detail "
                        "must be retained"
                    )
                    warnings.append(warning)
                    account_warnings.append(warning)
                    coverage += "; positions_unreconciled"
            else:
                payload = metrics.model_dump(mode="json", by_alias=False)
                key = f"account/{profile}.json"
                kind = "account"
                coverage = "broker_snapshot"
            accounts[account_code] = payload
            artifact = self.artifacts.put_json(
                key=key,
                payload=payload,
                kind=kind,
                as_of=metrics.fetched_at.date().isoformat(),
                producer_version=self.version,
                quality=ArtifactQuality(
                    status="warning" if account_warnings else "verified",
                    coverage=coverage,
                    warnings=account_warnings,
                ),
            )
            artifact_refs.append(artifact.ref)

        aggregate = self.artifacts.put_json(
            key=(
                "account/intraday/broker_values.json"
                if intraday
                else "account/broker_snapshot_metrics.json"
            ),
            payload={
                "schema_version": 1,
                "generated_at_utc": max(account["fetched_at"] for account in accounts.values()),
                "accounts": accounts,
            },
            kind="account_intraday_value" if intraday else "account",
            producer_version=self.version,
            dependency_artifact_ids=[artifact.artifact_id for artifact in artifact_refs],
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{len(accounts)}/{len(self.profiles)}",
                warnings=warnings,
            ),
        )
        return StageResult(
            artifacts=(*artifact_refs, aggregate.ref),
            warnings=tuple(warnings),
        )


class AccountPolicyStage:
    """Calculate realized campaign policy metrics from verified exports."""

    name = "accounts.policy"
    version = "policy-v1"
    required_for = frozenset({"all", "accounts"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        profiles: tuple[str, ...] = ("invest", "isa"),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.profiles = profiles

    def _transactions(self, profile: str):
        path = latest_export_path(
            profile,
            data_root=self.state_root / "trading212",
        )
        if path is None:
            raise StageExecutionError(
                "account.ledger_missing",
                f"no managed Trading 212 export for {profile}",
            )
        try:
            return load_transactions([path])
        except Exception as exc:
            raise StageExecutionError(
                "account.ledger_invalid",
                f"{profile}: {exc}",
            ) from exc

    def run(self, context: StageContext) -> StageResult:
        transactions = {
            code: self._transactions(profile) for code, profile in (("A", "invest"), ("B", "isa"))
        }
        payload = policy_metrics(transactions)
        artifact = self.artifacts.put_json(
            key="account/policy_metrics.json",
            payload=payload,
            kind="account_policy",
            as_of=max(str(frame["Time"].max().date()) for frame in transactions.values()),
            producer_version=self.version,
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(transactions)}/2 accounts",
            ),
        )
        return StageResult(artifacts=(artifact.ref,))


class _AccountLedgerStage:
    """Shared strict input boundary for account ledger-derived stages."""

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        profiles: tuple[tuple[str, str], ...] = (("A", "invest"), ("B", "isa")),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.profiles = profiles

    def _transactions(self, profile: str):
        path = latest_export_path(
            profile,
            data_root=self.state_root / "trading212",
        )
        if path is None:
            raise StageExecutionError(
                "account.ledger_missing",
                f"no managed Trading 212 export for {profile}",
            )
        try:
            return load_transactions([path])
        except Exception as exc:
            raise StageExecutionError(
                "account.ledger_invalid",
                f"{profile}: {exc}",
            ) from exc

    def _positions(self, context: StageContext) -> dict[str, list[dict]]:
        positions: dict[str, list[dict]] = {}
        for artifact_id in context.upstream_artifact_ids:
            try:
                stored = self.artifacts.get_json(artifact_id)
            except FileNotFoundError:
                continue
            if stored.ref.key not in {"account/invest.json", "account/isa.json"}:
                continue
            profile = "invest" if stored.ref.key.endswith("invest.json") else "isa"
            positions[profile] = list(stored.payload.get("positions", []))
        missing = [profile for _, profile in self.profiles if profile not in positions]
        if missing:
            raise StageExecutionError(
                "account.snapshot_dependency_missing",
                f"missing account snapshot artifact(s): {', '.join(missing)}",
            )
        return positions


class AccountDilutedCostStage(_AccountLedgerStage):
    """Publish negative-capable diluted-cost metrics from the open campaigns."""

    name = "accounts.diluted_cost"
    version = "diluted-cost-v2"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def run(self, context: StageContext) -> StageResult:
        from trading_max.analytics.ledger import diluted_cost_rows

        positions = self._positions(context)
        rows: list[dict] = []
        try:
            for code, profile in self.profiles:
                rows.extend(
                    diluted_cost_rows(
                        code,
                        self._transactions(profile),
                        positions[profile],
                    )
                )
        except StageExecutionError:
            raise
        except Exception as exc:
            raise StageExecutionError(
                "account.diluted_cost_failed",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="account/diluted_cost_metrics.json",
            payload={
                "schema_version": 2,
                "method": (
                    "Open campaign cash basis: buys plus buy fees minus net "
                    "sales and distributions; divided by remaining shares."
                ),
                "holdings": rows,
            },
            kind="diluted_cost",
            producer_version=self.version,
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(rows)} open positions",
            ),
        )
        return StageResult(artifacts=(artifact.ref,))


class AccountCapitalRecoveryStage(_AccountLedgerStage):
    """Publish strict campaign recovery metrics and reconciliation checks."""

    name = "accounts.capital_recovery"
    version = "capital-recovery-v2"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def run(self, context: StageContext) -> StageResult:
        from trading_max.analytics.ledger import capital_recovery_rows

        positions = self._positions(context)
        holdings: list[dict] = []
        checks: list[dict] = []
        try:
            for code, profile in self.profiles:
                account_rows, account_checks = capital_recovery_rows(
                    code,
                    self._transactions(profile),
                    positions[profile],
                )
                holdings.extend(account_rows)
                checks.extend(account_checks)
        except StageExecutionError:
            raise
        except Exception as exc:
            raise StageExecutionError(
                "account.capital_recovery_failed",
                str(exc),
            ) from exc
        checks_all_ok = all(check["status"] == "OK" for check in checks)
        if not checks_all_ok:
            raise StageExecutionError(
                "account.reconciliation_mismatch",
                "ledger and broker holdings do not reconcile",
            )
        artifact = self.artifacts.put_json(
            key="account/capital_recovery.json",
            payload={
                "schema_version": 2,
                "method": {
                    "ending_valuation": "Trading 212 native GBP position value",
                    "capital_recovered": ("net sell cash plus dividends during the open campaign"),
                },
                "checks_all_ok": checks_all_ok,
                "checks": checks,
                "account_summary": [],
                "holdings": holdings,
                "cfd_open_positions": {},
            },
            kind="capital_recovery",
            producer_version=self.version,
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(checks)} reconciliation checks",
            ),
        )
        return StageResult(artifacts=(artifact.ref,))


__all__ = [
    "AccountCapitalRecoveryStage",
    "AccountDilutedCostStage",
    "AccountPolicyStage",
    "AccountSnapshotStage",
]
