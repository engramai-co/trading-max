from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import Mock

import pytest
from trading_max.application import BrokerSyncStage, StageContext, StageRegistry
from trading_max.application.errors import StageExecutionError
from trading_max.application.stages import idempotency_key
from trading_max.ingestion.brokers.trading212 import (
    Trading212ExportSchemaError,
    Trading212HTTPError,
)


@pytest.mark.parametrize("trigger", ["on_demand", "intraday"])
@pytest.mark.parametrize(
    "error",
    [
        Trading212ExportSchemaError("invalid columns"),
        Trading212HTTPError(401, "unauthorized"),
        Trading212HTTPError(503, "unavailable"),
    ],
)
def test_broker_stage_preserves_failure_retryability(
    tmp_path: Path, trigger: str, error: Exception
) -> None:
    sync = Mock()
    sync.sync.side_effect = error
    sync.snapshot_only.side_effect = error
    stage = BrokerSyncStage(tmp_path, Mock(), sync=sync, profiles=("invest",))
    with pytest.raises(StageExecutionError) as caught:
        stage.run(StageContext(job_id="test", scope="all", trigger=trigger))
    assert caught.value.retryable == error.retryable


class _FirstStage:
    name = "first"
    version = "v1"
    required_for = frozenset({"research"})
    dependencies: tuple[str, ...] = ()

    def run(self, context):
        raise AssertionError("not executed")


class _SecondStage:
    name = "second"
    version = "v1"
    required_for = frozenset({"research"})
    dependencies = ("first",)

    def run(self, context):
        raise AssertionError("not executed")


def test_registry_rejects_missing_or_misordered_dependencies() -> None:
    registry = StageRegistry([_FirstStage(), _SecondStage()])

    registry.validate_order(["first", "second"])

    with pytest.raises(ValueError, match="must run after"):
        registry.validate_order(["second", "first"])
    with pytest.raises(ValueError, match="missing dependency"):
        registry.validate_order(["second"])


def test_stage_idempotency_key_is_stable_and_input_sensitive() -> None:
    stage = _FirstStage()
    base = StageContext(
        job_id="job-a",
        scope="research",
        tickers=("NVDA", "BE"),
        upstream_artifact_ids=("a" * 64, "b" * 64),
    )

    assert idempotency_key(stage, base) == idempotency_key(
        stage,
        base.__class__(
            job_id="job-b",
            scope="research",
            tickers=("BE", "NVDA"),
            upstream_artifact_ids=("b" * 64, "a" * 64),
        ),
    )
    assert idempotency_key(
        stage,
        base.__class__(
            job_id="job-c",
            scope="research",
            tickers=("BE", "NVDA"),
            upstream_artifact_ids=("c" * 64,),
        ),
    ) != idempotency_key(stage, base)


def test_broker_export_window_uses_the_utc_calendar_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TRADING_MAX_BROKER_EXPORT_START", raising=False)
    monkeypatch.setenv("TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS", "365")

    start, end = BrokerSyncStage._window(now=datetime(2026, 8, 8, 23, 30, tzinfo=UTC))

    assert start == date(2025, 8, 8)
    assert end == date(2026, 8, 8)
