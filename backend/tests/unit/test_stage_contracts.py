from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from trading_max.application import BrokerSyncStage, StageContext, StageRegistry
from trading_max.application.stages import idempotency_key


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
