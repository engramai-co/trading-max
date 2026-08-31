from __future__ import annotations

from pathlib import Path

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot, LookthroughService
from trading_max.application import (
    PortfolioLookthroughStage,
    StageRegistry,
    StageResult,
)
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SqliteDatabase,
    SqliteJobQueue,
)
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityEntityRecord,
    SecurityMasterCatalog,
)
from trading_max.worker import DurableWorker

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


class _AccountProducerStage:
    name = "accounts.snapshot"
    version = "accounts-v1"
    required_for = frozenset({"accounts"})
    dependencies: tuple[str, ...] = ()

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context):
        refs = []
        for profile, value in (("invest", 90), ("isa", 0)):
            stored = self.artifacts.put_json(
                key=f"account/{profile}.json",
                payload={
                    "fetched_at": "2026-08-07T20:00:00Z",
                    "investments_value_gbp": value,
                    "cash_gbp": 0,
                    "positions": (
                        [
                            {
                                "ticker": "XUSE",
                                "isin": "IE000R4ZNTN3",
                                "current_value_gbp": value,
                            }
                        ]
                        if value
                        else []
                    ),
                },
                kind="account",
                producer_version=self.version,
            )
            refs.append(stored.ref)
        return StageResult(artifacts=tuple(refs))


class _FundProvider:
    def fetch(self, ticker: str) -> FundSnapshot | None:
        if ticker != "XUSE":
            return None
        return FundSnapshot(
            ticker="XUSE",
            as_of="2026-08-07",
            holdings=[
                FundHolding(
                    ticker="AAPL",
                    name="Apple Inc.",
                    isin="US0378331005",
                    country="United States",
                    industry="Information Technology",
                    weight_pct=100,
                )
            ],
        )


class _ReferenceStage:
    name = "reference.security_master"
    version = "security-master-v3"
    required_for = frozenset({"accounts"})
    dependencies = ("accounts.snapshot",)

    @staticmethod
    def run(_context) -> StageResult:
        return StageResult()


def test_durable_worker_executes_lookthrough_after_account_snapshot(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    queue = SqliteJobQueue(SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS))
    producer = _AccountProducerStage(artifacts)
    lookthrough = PortfolioLookthroughStage(
        tmp_path,
        artifacts,
        LookthroughService(
            _FundProvider(),
            CatalogSecurityMaster(
                SecurityMasterCatalog(
                    records=[
                        SecurityEntityRecord(
                            entity_id="fund:xuse",
                            canonical_ticker="XUSE",
                            entity_name="World ex-USA",
                            security_type="ETF",
                            ticker_aliases=["XUSE"],
                            source="test-profile",
                        )
                    ]
                )
            ),
        ),
    )
    queue.enqueue(
        "accounts",
        skip_sync=True,
        stages=[
            ("accounts.snapshot", "accounts-v1"),
            ("reference.security_master", "security-master-v3"),
            ("portfolio.lookthrough", "lookthrough-v8"),
        ],
        job_id="lookthrough-worker",
    )
    worker = DurableWorker(
        queue,
        StageRegistry([producer, _ReferenceStage(), lookthrough]),
        worker_id="lookthrough-worker-id",
        snapshot_id_factory=lambda _: "lookthrough-snapshot",
    )

    assert worker.run_once() is True

    record = queue.get("lookthrough-worker")
    assert record.status.value == "succeeded"
    assert record.stages[2].status.value == "succeeded"
    lookthrough_id = record.stages[2].artifact_ids[0]
    stored = artifacts.get_json(lookthrough_id)
    assert stored.ref.key == "account/lookthrough_metrics.json"
    assert stored.payload["lookthroughCoveragePct"] == 1.0
    worker.close()
