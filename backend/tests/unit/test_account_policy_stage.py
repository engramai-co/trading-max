from __future__ import annotations

from pathlib import Path

from trading_max.application.account_stages import (
    AccountCapitalRecoveryStage,
    AccountDilutedCostStage,
    AccountPolicyStage,
)
from trading_max.application.stages import StageContext
from trading_max.infrastructure import ContentAddressedArtifactStore


def _export(path: Path) -> None:
    path.parent.mkdir(parents=True)
    path.write_text(
        "ID,Action,Time (UTC),Ticker,Name,No. of shares,Price / share,Total,"
        "Currency conversion fee,Result\n"
        "1,Market buy,2026-08-01T10:00:00Z,BE,Bloom,1,10,10,0,\n"
        "2,Market sell,2026-08-02T10:00:00Z,BE,Bloom,1,12,12,0,2\n",
        encoding="utf-8",
    )


def test_account_policy_stage_publishes_typed_compatible_shape(
    tmp_path: Path,
) -> None:
    _export(tmp_path / "trading212" / "invest" / "exports" / "latest.csv")
    _export(tmp_path / "trading212" / "isa" / "exports" / "latest.csv")
    for profile in ("invest", "isa"):
        (tmp_path / "trading212" / profile / "latest_export.json").write_text(
            '{"profile":"' + profile + '","csv":{"path":"' + profile + '/exports/latest.csv"}}',
            encoding="utf-8",
        )
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")

    result = AccountPolicyStage(tmp_path, store).run(StageContext(job_id="job", scope="accounts"))

    payload = store.get_json(result.artifacts[0].artifact_id).payload
    assert payload["a_campaign"]["closed_campaigns"] == 1
    assert payload["b_policy"][0]["Bucket"] == "All ISA trades"


def test_account_policy_stage_fails_without_managed_export(tmp_path: Path) -> None:
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")
    try:
        AccountPolicyStage(tmp_path, store)._transactions("invest")
    except Exception as exc:
        assert getattr(exc, "code", None) == "account.ledger_missing"
    else:
        raise AssertionError("missing ledger should fail loudly")


def _account_artifacts(
    root: Path,
    store: ContentAddressedArtifactStore,
) -> tuple[str, ...]:
    refs: list[str] = []
    for profile in ("invest", "isa"):
        stored = store.put_json(
            key=f"account/{profile}.json",
            payload={
                "profile": profile,
                "positions": [
                    {
                        "ticker": "BE",
                        "name": "Bloom Energy",
                        "quantity": 1,
                        "current_value_gbp": 30,
                    }
                ],
            },
            kind="account",
            producer_version="fixture",
        )
        refs.append(stored.ref.artifact_id)
    return tuple(refs)


def test_account_ledger_stages_publish_cost_and_recovery(
    tmp_path: Path,
) -> None:
    for profile in ("invest", "isa"):
        export = tmp_path / "trading212" / profile / "exports" / "latest.csv"
        export.parent.mkdir(parents=True)
        export.write_text(
            "ID,Action,Time (UTC),Ticker,Name,No. of shares,Price / share,Total,"
            "Currency conversion fee,Result\n"
            "1,Market buy,2026-08-01T10:00:00Z,BE,Bloom,1,10,10,0,\n",
            encoding="utf-8",
        )
    for profile in ("invest", "isa"):
        (tmp_path / "trading212" / profile / "latest_export.json").write_text(
            '{"profile":"' + profile + '","csv":{"path":"' + profile + '/exports/latest.csv"}}',
            encoding="utf-8",
        )
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")
    context = StageContext(
        job_id="job",
        scope="accounts",
        upstream_artifact_ids=_account_artifacts(tmp_path, store),
    )

    diluted = AccountDilutedCostStage(tmp_path, store).run(context)
    recovery = AccountCapitalRecoveryStage(tmp_path, store).run(
        StageContext(
            job_id="job",
            scope="accounts",
            upstream_artifact_ids=(
                *context.upstream_artifact_ids,
                *(item.artifact_id for item in diluted.artifacts),
            ),
        )
    )

    diluted_payload = store.get_json(diluted.artifacts[0].artifact_id).payload
    recovery_payload = store.get_json(recovery.artifacts[0].artifact_id).payload
    assert len(diluted_payload["holdings"]) == 2
    assert recovery_payload["checks_all_ok"] is True
    assert len(recovery_payload["holdings"]) == 2
