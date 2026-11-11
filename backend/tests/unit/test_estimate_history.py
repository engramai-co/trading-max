from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from trading_max.application import StageContext
from trading_max.application.research_stages import (
    AnalystArtifactStage,
    FundamentalsArtifactStage,
    TypedPublishSnapshotStage,
)
from trading_max.infrastructure import SnapshotStore, SqliteDatabase
from trading_max.research.estimate_history import EstimateHistory, EstimateObservation
from trading_max.research.fundamentals import YFinanceResearchService

NOW = datetime(2026, 10, 20, 10, tzinfo=UTC)


@pytest.fixture
def history(tmp_path):
    db = SqliteDatabase(tmp_path / "trading_max.db")
    try:
        yield EstimateHistory(db)
    finally:
        db.close()


def test_append_keeps_changes_and_skips_only_consecutive_identical_rows(history):
    def row(hour: int, multiple: float, ticker: str = "TEST.L") -> EstimateObservation:
        return EstimateObservation(
            ticker=ticker, observed_at=NOW + timedelta(hours=hour), forwardPE=multiple
        )

    assert history.append([row(0, 18), row(1, 18), row(2, 22), row(3, 18), row(3, 18, "TEST")]) == 4
    assert [(x.observed_at.hour, x.forward_pe) for x in history.list("test.l", limit=10)] == [
        (10, 18),
        (12, 22),
        (13, 18),
    ]
    assert [x.forward_pe for x in history.list("test.l", limit=2)] == [22, 18]
    assert [x.forward_pe for x in history.list("TEST", limit=2)] == [18]


def test_scheduled_publication_archives_only_fresh_estimates(tmp_path, history):
    snapshots = SnapshotStore(tmp_path)
    artifacts = snapshots.artifacts
    price = 1_830
    failed = False

    def info(ticker):
        if ticker == "FUND.L":
            return {"quoteType": "ETF", "currency": "GBP", "regularMarketPrice": 10.0}
        return {
            "currency": "GBp" if ticker.endswith(".L") else "USD",
            "financialCurrency": "USD",
            "regularMarketPrice": price,
            "regularMarketTime": 1792490400,
            "fullExchangeName": "LSE" if ticker.endswith(".L") else "NasdaqGS",
            "forwardPE": 18.3,
            "forwardEps": 1.25,
            "trailingEps": 0,
        }

    def analyst(ticker):
        if ticker == "TEST.L" and failed:
            raise TimeoutError("synthetic provider timeout")
        if ticker == "FUND.L":
            return {}
        return {
            "asOf": "2026-10-20T10:00:00Z",  # Our adapter's clock, not the provider's.
            "earningsEstimate": [
                {"period": "+1y", "avg": 3.5, "high": 4, "numberOfAnalysts": 12},
                {"index": "0q", "avg": 0, "low": float("nan"), "growth": 0},
                {"period": "unrecognized", "avg": 999},
            ],
            "fiscalPeriods": [
                {"period": "+1y", "endDate": "2027-12-31", "earningsCurrency": "USD"}
            ],
        }

    service = YFinanceResearchService(info_loader=info, analyst_loader=analyst)
    publisher = TypedPublishSnapshotStage(artifacts, snapshots, estimate_history=history)
    stages = (
        FundamentalsArtifactStage(artifacts, service),
        AnalystArtifactStage(artifacts, service),
    )

    def run(trigger="research"):
        context = StageContext(
            job_id="test", scope="research", trigger=trigger, tickers=("TEST.L", "TEST", "FUND.L")
        )
        results = [stage.run(context) for stage in stages]
        stage_result = publisher.run(
            StageContext(
                job_id=context.job_id,
                scope=context.scope,
                trigger=context.trigger,
                tickers=context.tickers,
                upstream_artifact_ids=tuple(result.artifacts[0].artifact_id for result in results),
            )
        )
        return snapshots.load(stage_result.metadata["snapshot_run_id"]), results[1].warnings

    first, _ = run()
    row = history.list("TEST.L", limit=10)[0]
    assert row.observed_at == first.manifest.created_at
    assert (row.listing, row.currency, row.quote_unit, row.price) == (
        "LSE:TEST",
        "GBP",
        "GBp",
        18.3,
    )
    assert row.price_as_of is not None and row.provider_as_of is None
    assert row.forward_pe == 18.3 and row.forward_eps == 1.25
    assert row.trailing_pe is None and row.trailing_eps == 0
    quarterly, annual = row.consensus
    assert quarterly.period == "0q" and quarterly.mean_eps == 0 and quarterly.growth == 0
    assert quarterly.low_eps is None and quarterly.analyst_count is None
    assert annual.period == "+1y" and annual.period_end.isoformat() == "2027-12-31"
    assert annual.currency == "USD" and annual.analyst_count == 12
    assert history.list("FUND.L", limit=10) == []

    price = 1_900
    failed = True
    second, warnings = run()
    assert any("TEST.L" in warning and "TimeoutError" in warning for warning in warnings)
    assert history.list("TEST.L", limit=10) == [row]
    assert [item.price for item in history.list("TEST", limit=10)] == [1_830, 1_900]
    analyst_ref = next(
        ref for ref in second.manifest.artifacts if ref.key == "research/analyst.json"
    )
    assert (
        artifacts.get_json(analyst_ref.artifact_id).payload["rowClocks"]["TEST.L"]["state"]
        == "stale"
    )

    price = 1_950
    run("on_demand")
    assert [item.price for item in history.list("TEST", limit=10)] == [1_830, 1_900]


def test_recovery_uses_original_publication_time_once_and_skips_inherited_data(tmp_path, history):
    snapshots = SnapshotStore(tmp_path)
    generated_at = datetime.now(UTC)
    artifacts = snapshots.artifacts

    def batches(value):
        return [
            artifacts.put_json(
                key=f"research/{key}.json",
                payload={
                    "artifact_type": kind,
                    "generated_at": datetime.now(UTC).isoformat(),
                    "rows": [row],
                },
            )
            for key, kind, row in (
                (
                    "fundamentals",
                    "fundamentals_research_batch",
                    {"ticker": "TEST", "currency": "USD", "metrics": {"forwardPE": value}},
                ),
                ("analyst", "analyst_research_batch", {"ticker": "TEST", "analyst": {}}),
            )
        ]

    first = snapshots.publish(scope="research", source="fixture", artifacts=batches(18))
    inherited = snapshots.publish(
        scope="research", source="fixture-inherited", artifacts=first.manifest.artifacts
    )
    second = snapshots.publish(scope="all", source="fixture", artifacts=batches(24))
    live = snapshots.publish(scope="research", source="fixture-live", artifacts=batches(26))
    manifests = {x.path: x.path.read_bytes() for x in (first, inherited, second, live)}
    assert history.recover(snapshots, before=live.manifest.created_at) == 2
    assert history.recover(snapshots, before=datetime.now(UTC)) == 0
    rows = history.list("TEST", limit=10)
    assert [row.forward_pe for row in rows] == [18, 24]
    assert all(row.recovered and row.observed_at > generated_at for row in rows)
    assert [row.observed_at for row in rows] == [
        first.manifest.created_at,
        second.manifest.created_at,
    ]
    assert {path: path.read_bytes() for path in manifests} == manifests
