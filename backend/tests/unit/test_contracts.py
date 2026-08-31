from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from trading_max.application import StageContext, StageRegistry, StageResult
from trading_max.domain import ArtifactRef, InstrumentId, JobRecord, SnapshotManifest


def test_domain_contracts_serialize_camel_case_and_reject_unknown_fields() -> None:
    instrument = InstrumentId(ticker=" AVGO ", bloomberg_ticker="AVGO US Equity")
    artifact = ArtifactRef(
        artifact_id="sha256:abc",
        key="research/technical",
        sha256="abc",
        generated_at=datetime(2026, 8, 7, tzinfo=UTC),
    )
    manifest = SnapshotManifest(
        run_id="run-1",
        scope="research",
        source="test",
        artifacts=[artifact],
    )

    assert instrument.ticker == "AVGO"
    assert manifest.model_dump(by_alias=True)["runId"] == "run-1"
    assert manifest.model_dump(by_alias=True)["artifacts"][0]["artifactId"] == ("sha256:abc")
    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="sha256:bad",
            key="x",
            sha256="bad",
            unknown="must fail",
        )


class _DemoStage:
    name = "demo"
    version = "1"
    required_for = frozenset({"research"})

    def run(self, context: StageContext) -> StageResult:
        return StageResult(metadata={"job_id": context.job_id})


def test_stage_registry_is_typed_and_rejects_duplicates() -> None:
    registry = StageRegistry([_DemoStage()])
    assert registry.names() == ("demo",)
    assert (
        registry.get("demo").run(StageContext(job_id="j", scope="research")).metadata["job_id"]
        == "j"
    )
    with pytest.raises(ValueError, match="duplicate stage"):
        registry.register(_DemoStage())


def test_job_contract_has_durable_worker_fields() -> None:
    record = JobRecord(job_id="job-1", scope="all")
    payload = record.model_dump(by_alias=True)
    assert payload["leaseExpiresAt"] is None
    assert payload["errorCode"] is None
