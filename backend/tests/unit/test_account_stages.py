import json
from pathlib import Path

import pytest
from trading_max.application import AccountIntradayNavStage, AccountSnapshotStage, StageContext
from trading_max.application.errors import StageExecutionError
from trading_max.application.nav_stages import AccountDayAttributionStage
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore


def _write_snapshot(
    root: Path,
    profile: str,
    total: str,
    *,
    position_total: str | None = None,
    fetched_at: str = "2026-08-07T20:00:00Z",
    cash_total: str | None = None,
) -> None:
    stamp = fetched_at.replace(":", "").replace("-", "")
    path = root / "trading212" / profile / "snapshots" / f"snapshot_{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "fetched_at_utc": fetched_at,
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": cash_total or total,
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


def _performance_run(tmp_path: Path):
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    result = AccountSnapshotStage(tmp_path, artifacts).run(
        StageContext(job_id="perf", scope="performance", trigger="performance", skip_sync=True)
    )
    refs = {ref.key: ref for ref in result.artifacts}
    return artifacts, result, refs


def test_reused_live_snapshot_falls_back_to_recent_reconciled_positions(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", fetched_at="2026-08-07T13:20:00Z")
    _write_snapshot(tmp_path, "isa", "101", position_total="104", fetched_at="2026-08-07T13:30:00Z")

    artifacts, result, refs = _performance_run(tmp_path)

    isa = artifacts.get_json(refs["account/isa.json"].artifact_id)
    assert isa.payload["total_value_gbp"] == "100"
    assert isa.payload["fetched_at"].startswith("2026-08-07T13:20:00")
    assert isa.ref.quality.status == "verified"
    aggregate = refs["account/broker_snapshot_metrics.json"]
    assert aggregate.quality.status == "verified"
    assert any("13:20 UTC" in warning for warning in result.warnings)


def test_reused_live_snapshot_stays_strict_beyond_the_fallback_window(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", fetched_at="2026-08-07T12:50:00Z")
    _write_snapshot(tmp_path, "isa", "101", position_total="104", fetched_at="2026-08-07T13:30:00Z")

    with pytest.raises(StageExecutionError, match=r"positions_match_investments.*False"):
        _performance_run(tmp_path)


def test_reused_live_snapshot_does_not_fall_back_from_an_invalid_summary(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", fetched_at="2026-08-07T13:20:00Z")
    _write_snapshot(
        tmp_path,
        "isa",
        "101",
        position_total="104",
        cash_total="150",
        fetched_at="2026-08-07T13:30:00Z",
    )

    with pytest.raises(StageExecutionError, match="cash_plus_investments_matches_total"):
        _performance_run(tmp_path)


def test_full_refresh_never_falls_back_to_an_older_snapshot(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100", fetched_at="2026-08-07T13:20:00Z")
    _write_snapshot(tmp_path, "isa", "101", position_total="104", fetched_at="2026-08-07T13:30:00Z")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")

    with pytest.raises(StageExecutionError, match=r"positions_match_investments.*False"):
        AccountSnapshotStage(tmp_path, artifacts).run(
            StageContext(job_id="full", scope="accounts", trigger="nightly")
        )


def test_window_attribution_rebuilds_missing_openings_from_raw_snapshots(
    tmp_path: Path,
) -> None:
    # The opening on 28 October exists only as a raw broker snapshot.
    _write_snapshot(tmp_path, "invest", "100", fetched_at="2026-10-28T00:10:00Z")
    _write_snapshot(tmp_path, "isa", "200", fetched_at="2026-10-28T00:10:00Z")
    _write_snapshot(tmp_path, "invest", "110", fetched_at="2026-11-03T15:00:00Z")
    _write_snapshot(tmp_path, "isa", "190", fetched_at="2026-11-03T15:00:00Z")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    accounts = AccountSnapshotStage(tmp_path, artifacts).run(
        StageContext(job_id="live", scope="intraday", trigger="intraday")
    )

    result = AccountDayAttributionStage(
        artifacts, SnapshotStore(tmp_path), state_root=tmp_path
    ).run(
        StageContext(
            job_id="attribution",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in accounts.artifacts),
        )
    )

    refs = {ref.key: ref for ref in result.artifacts}
    window = artifacts.get_json(refs["account/attribution/window.json"].artifact_id).payload
    assert window["start_day"] == "2026-10-28" and window["day"] == "2026-11-03"
    assert window["accounts"]["A"]["since"].startswith("2026-10-28T00:10")
    assert window["accounts"]["A"]["contributions"][0]["contribution_gbp"] == "10.00"
    assert window["accounts"]["B"]["contributions"][0]["contribution_gbp"] == "-10.00"
    day = artifacts.get_json(refs["account/attribution/day.json"].artifact_id).payload
    assert day["accounts"]["A"]["contributions"][0]["contribution_gbp"] == "0.00"


def test_day_attribution_waits_for_an_account_still_on_an_earlier_trading_day(
    tmp_path: Path,
) -> None:
    # The ISA has reached Monday; the invest account's latest snapshot is Friday's.
    _write_snapshot(tmp_path, "invest", "100", fetched_at="2026-11-06T16:00:00Z")
    _write_snapshot(tmp_path, "isa", "200", fetched_at="2026-11-09T08:00:00Z")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    accounts = AccountSnapshotStage(tmp_path, artifacts).run(
        StageContext(job_id="live", scope="intraday", trigger="intraday")
    )

    result = AccountDayAttributionStage(
        artifacts, SnapshotStore(tmp_path), state_root=tmp_path
    ).run(
        StageContext(
            job_id="attribution",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in accounts.artifacts),
        )
    )

    refs = {ref.key: ref for ref in result.artifacts}
    baseline = artifacts.get_json(refs["account/attribution/day_baseline.json"].artifact_id)
    day = artifacts.get_json(refs["account/attribution/day.json"].artifact_id)
    assert day.payload["day"] == "2026-11-09"
    assert set(day.payload["accounts"]) == set(baseline.payload["accounts"]) == {"B"}
    assert result.warnings == ("day attribution waits for a 2026-11-09 observation: A",)
    assert day.ref.quality.coverage == "1/2"
