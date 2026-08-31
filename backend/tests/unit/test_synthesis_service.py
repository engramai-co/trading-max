from __future__ import annotations

from pathlib import Path

from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.synthesis import (
    AnalysisDefinition,
    FakeProvider,
    SynthesisService,
)


def test_synthesis_service_persists_snapshot_bound_structured_artifact(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    service = SynthesisService(artifacts, FakeProvider())

    stored = service.analyze(
        AnalysisDefinition(
            analysis_id="daily_cio_brief",
            title="Daily CIO brief",
        ),
        {
            "snapshotRunId": "snapshot-2026-08-07",
            "ticker": "NVDA",
            "dashboard": {"totalValueGbp": "100"},
        },
        input_artifact_ids=["a" * 64, "b" * 64],
        input_hash="input-hash-1",
    )

    assert stored.ref.key == "synthesis/daily_cio_brief/NVDA.json"
    assert stored.ref.kind == "llm_synthesis"
    assert stored.ref.dependency_artifact_ids == ["a" * 64, "b" * 64]
    assert stored.payload["response"]["headline"]["zh"]
    assert stored.payload["snapshot_run_id"] == "snapshot-2026-08-07"
    assert stored.payload["analysis_id"] == "daily_cio_brief"
    assert "page" not in stored.payload
    assert stored.payload["input_hash"] == "input-hash-1"
    assert stored.payload["fake"] is True


def test_synthesis_service_requires_snapshot_identity(tmp_path: Path) -> None:
    service = SynthesisService(
        ContentAddressedArtifactStore(tmp_path / "artifacts"),
        FakeProvider(),
    )

    try:
        service.analyze(
            AnalysisDefinition(
                analysis_id="daily_cio_brief",
                title="Daily CIO brief",
            ),
            {},
        )
    except ValueError as exc:
        assert "snapshotRunId" in str(exc)
    else:
        raise AssertionError("missing snapshot identity was accepted")
