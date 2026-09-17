"""Extend cash-flow evidence during live collection without fetching market history."""

import hashlib
from pathlib import Path

from trading_max.analytics.cash_flow_history import AccountCashFlowHistory, extend_live_cash_flows
from trading_max.domain import ArtifactQuality, ArtifactRef
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.ingestion.brokers.trading212 import (
    latest_cash_transactions_path,
    latest_export_path,
)


def ledger_digest(sources: tuple[Path | None, Path | None]) -> str:
    digest = hashlib.sha256()
    for source in sources:
        digest.update(source.read_bytes() if source is not None else b"absent")
        digest.update(b"\0")
    return digest.hexdigest()


def live_cash_flow_refs(
    artifacts: ContentAddressedArtifactStore,
    snapshots: SnapshotStore,
    state_root: Path | None,
    accounts: dict[str, dict],
    account_artifact_ids: list[str],
    producer_version: str,
) -> list[ArtifactRef]:
    previous = snapshots.latest()
    if state_root is None or previous is None:
        return []
    existing = {ref.key: ref for ref in previous.manifest.artifacts}
    result = []
    for index, (code, profile) in enumerate((("A", "invest"), ("B", "isa"))):
        key = f"account/nav/cash_flows_{code.lower()}.json"
        ref = existing.get(key)
        if ref is None:
            continue
        try:
            history = AccountCashFlowHistory.model_validate(
                artifacts.get_json(ref.artifact_id).payload
            )
            export = latest_export_path(profile, data_root=state_root / "trading212")
            if export is None:
                continue
            digest = ledger_digest(
                (
                    export,
                    latest_cash_transactions_path(profile, data_root=state_root / "trading212"),
                )
            )
            extended = extend_live_cash_flows(history, accounts[code], digest)
        except (OSError, KeyError, TypeError, ValueError):
            # Preserve last verified evidence; a live mark must not certify an
            # unreadable ledger or interrupt broker-value collection.
            continue
        if extended is None:
            continue
        stored = artifacts.put_json(
            key=key,
            payload=extended.model_dump(mode="json", by_alias=False),
            kind="account_cash_flows",
            as_of=extended.covered_until.isoformat(),
            producer_version=producer_version,
            dependency_artifact_ids=[ref.artifact_id, account_artifact_ids[index]],
            quality=ArtifactQuality(
                status="verified",
                coverage="reconciled cash flows; unchanged live cash and position quantities",
            ),
        )
        result.append(stored.ref)
    return result
