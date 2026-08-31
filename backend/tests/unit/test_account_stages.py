import json
from pathlib import Path

import pytest
from trading_max.application import AccountIntradayNavStage, AccountSnapshotStage, StageContext
from trading_max.application.errors import StageExecutionError
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore


def _write_snapshot(
    root: Path,
    profile: str,
    total: str,
    *,
    position_total: str | None = None,
) -> None:
    path = root / "trading212" / profile / "snapshots" / "snapshot_20260807.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "fetched_at_utc": "2026-08-07T20:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": total,
                    "cash": {"availableToTrade": "0"},
                    "investments": {
                        "currentValue": total,
                        "totalCost": "90",
                        "realizedProfitLoss": "1",
                        "unrealizedProfitLoss": "9",
                    },
                },
                "positions": [
                    {
                        "instrument": {
                            "ticker": "BE_US_EQ",
                            "name": "Bloom Energy",
                            "isin": "US0937121079",
                            "currency": "USD",
                        },
                        "quantity": "1",
                        "currentPrice": "100",
                        "walletImpact": {
                            "currentValue": position_total or total,
                            "totalCost": "90",
                            "unrealizedProfitLoss": "9",
                            "fxImpact": "0",
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_account_snapshot_stage_publishes_typed_account_artifacts(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    stage = AccountSnapshotStage(tmp_path, artifacts)

    result = stage.run(StageContext(job_id="job", scope="all"))

    assert len(result.artifacts) == 3
    aggregate = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/broker_snapshot_metrics.json"
        )
    )
    assert set(aggregate.payload["accounts"]) == {"A", "B"}


def test_intraday_snapshot_publishes_summary_only_when_positions_are_unreconciled(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", position_total="80")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")

    result = AccountSnapshotStage(tmp_path, artifacts).run(
        StageContext(job_id="intraday", scope="intraday", trigger="intraday")
    )

    refs = {ref.key: ref for ref in result.artifacts}
    assert set(refs) == {
        "account/intraday/invest.json",
        "account/intraday/isa.json",
        "account/intraday/broker_values.json",
    }
    invest = artifacts.get_json(refs["account/intraday/invest.json"].artifact_id)
    assert invest.payload["positions_status"] == "verified"
    assert invest.payload["positions"][0]["ticker"] == "BE"
    isa = artifacts.get_json(refs["account/intraday/isa.json"].artifact_id)
    assert isa.payload["total_value_gbp"] == "100"
    assert isa.payload["positions_status"] == "unreconciled"
    assert isa.payload["checks"]["positions_match_investments"] is False
    assert "positions" not in isa.payload
    assert isa.ref.quality.status == "warning"
    assert result.warnings

    aggregate = artifacts.get_json(refs["account/intraday/broker_values.json"].artifact_id)
    assert aggregate.payload["accounts"]["A"]["positions"][0]["ticker"] == "BE"
    assert "positions" not in aggregate.payload["accounts"]["B"]

    nav_result = AccountIntradayNavStage(artifacts, SnapshotStore(tmp_path)).run(
        StageContext(
            job_id="intraday-nav",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in result.artifacts),
        )
    )
    anchors = artifacts.get_json(nav_result.artifacts[0].artifact_id).payload
    assert anchors["points"][-1]["total_value_gbp"] == 200


def test_full_snapshot_remains_strict_when_positions_are_unreconciled(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", position_total="80")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")

    with pytest.raises(StageExecutionError, match=r"positions_match_investments.*False"):
        AccountSnapshotStage(tmp_path, artifacts).run(
            StageContext(job_id="full", scope="accounts", trigger="scheduled")
        )
