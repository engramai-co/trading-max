from pathlib import Path

import pytest
from trading_max.application import AccountPerformanceStage, StageContext
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.worker import StageExecutionError

NAV = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    "2026-08-01,0,1000,1000,0,0,,1,0\n"
    "2026-08-02,0,1020,1020,0,0,0.02,1.02,0\n"
    "2026-08-03,0,1010,1010,0,0,-0.0098039,1.01,-0.0098039\n"
)

NAV_WITH_INTRADAY_WEIGHTED_FLOW = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    "2026-08-01,0,1000,1000,0,0,,1,0\n"
    "2026-08-02,0,2010,2010,1000,250,0.005,1.005,0\n"
)

NAV_WITH_EMPTY_INITIAL_TWR = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    "2026-08-01,0,1000,1000,1000,1000,,,,\n"
    "2026-08-02,0,2010,2010,1000,250,0.005,1.005,0\n"
    "2026-08-03,0,2030.1,2030.1,0,0,0.01,1.01505,0\n"
)


def _seed_nav(
    tmp_path: Path,
    nav: str = NAV,
    *,
    technical: dict | None = None,
) -> tuple[ContentAddressedArtifactStore, SnapshotStore]:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)
    refs = [
        artifacts.put_bytes(
            key=f"account/nav/daily_nav_{code.lower()}.csv",
            content=nav.encode(),
            kind="nav_series",
            media_type="text/csv",
            producer_version="fixture-v1",
        )
        for code in ("A", "B")
    ]
    if technical is not None:
        refs.append(
            artifacts.put_json(
                key="research/technical.json",
                payload=technical,
                kind="technical",
                producer_version="fixture-v1",
            )
        )
    snapshots.publish(scope="accounts", source="fixture", artifacts=refs)
    return artifacts, snapshots


def test_account_performance_stage_uses_previous_immutable_nav(tmp_path: Path) -> None:
    artifacts, snapshots = _seed_nav(tmp_path)
    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload
    assert payload["A"]["periods"] == 2
    assert payload["B"]["twr_total_return"] == pytest.approx(0.01, abs=1e-8)


def test_account_performance_stage_fails_without_trusted_nav(tmp_path: Path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)

    with pytest.raises(StageExecutionError, match="trusted NAV history"):
        AccountPerformanceStage(artifacts, snapshots).run(
            StageContext(job_id="job", scope="accounts")
        )


def test_account_performance_stage_publishes_initial_baseline_without_ratios(
    tmp_path: Path,
) -> None:
    baseline = (
        "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
        "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
        "2026-08-01,10,90,100,0,0,,,0\n"
    )
    artifacts, snapshots = _seed_nav(tmp_path, baseline)

    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload
    assert len(result.warnings) == 2
    assert payload["A"]["periods"] == 0
    assert payload["A"]["twr_total_return"] is None
    assert payload["A"]["sharpe_sonia"] is None
    assert (
        next(
            ref for ref in result.artifacts if ref.key == "account/performance_a.json"
        ).quality.status
        == "warning"
    )


def test_account_performance_stage_uses_full_external_flow_not_dietz_weight(
    tmp_path: Path,
) -> None:
    artifacts, snapshots = _seed_nav(tmp_path, NAV_WITH_INTRADAY_WEIGHTED_FLOW)
    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload
    assert payload["A"]["twr_total_return"] == pytest.approx(0.005)
    assert payload["A"]["net_external_flows_gbp"] == pytest.approx(1000)


def test_account_performance_stage_bases_empty_initial_twr_at_one(
    tmp_path: Path,
) -> None:
    artifacts, snapshots = _seed_nav(tmp_path, NAV_WITH_EMPTY_INITIAL_TWR)
    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload
    assert payload["A"]["twr_total_return"] == pytest.approx(0.01505)
    assert payload["A"]["max_drawdown"] == pytest.approx(0.0)
    assert payload["A"]["net_external_flows_gbp"] == pytest.approx(2000)


def test_account_performance_stage_aligns_gbp_adjusted_voo_for_information_ratio(
    tmp_path: Path,
) -> None:
    technical = {
        "benchmark_currency": "GBP",
        "benchmark_return_basis": "auto_adjusted_close",
        "benchmark_series": {
            "VOO": [
                {"date": "2026-08-01", "close": 100.0},
                {"date": "2026-08-02", "close": 101.0},
                {"date": "2026-08-03", "close": 102.0},
            ]
        },
    }
    artifacts, snapshots = _seed_nav(tmp_path, technical=technical)

    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload["A"]
    assert payload["information_ratio"] is not None
    assert payload["benchmark_ticker"] == "VOO"
    assert payload["benchmark_total_return"] == pytest.approx(0.02)
    assert payload["benchmark_currency"] == "GBP"


def test_account_performance_stage_rejects_unconverted_benchmark(tmp_path: Path) -> None:
    technical = {
        "benchmark_currency": "USD",
        "benchmark_return_basis": "auto_adjusted_close",
        "benchmark_series": {
            "VOO": [
                {"date": "2026-08-01", "close": 100.0},
                {"date": "2026-08-02", "close": 101.0},
                {"date": "2026-08-03", "close": 102.0},
            ]
        },
    }
    artifacts, snapshots = _seed_nav(tmp_path, technical=technical)

    result = AccountPerformanceStage(artifacts, snapshots).run(
        StageContext(job_id="job", scope="accounts")
    )

    payload = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in result.artifacts
            if ref.key == "account/synthetic_nav_metrics.json"
        )
    ).payload["A"]
    assert payload["information_ratio"] is None
    assert payload["benchmark_ticker"] is None
