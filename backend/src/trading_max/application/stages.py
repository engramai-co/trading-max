"""Typed pipeline boundaries used by the future durable worker."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from trading_max.domain.contracts import ArtifactRef, JobScope


@dataclass(frozen=True, slots=True)
class StageContext:
    job_id: str
    scope: JobScope
    trigger: str = "on_demand"
    skip_sync: bool = False
    tickers: tuple[str, ...] = ()
    scheduled_for: datetime | None = None
    started_at: datetime | None = None
    log_path: str | None = None
    inputs: Mapping[str, ArtifactRef] = field(default_factory=dict)
    upstream_artifact_ids: tuple[str, ...] = ()
    configuration: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StageResult:
    artifacts: tuple[ArtifactRef, ...] = ()
    warnings: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)
    idempotency_key: str | None = None


class Stage(Protocol):
    name: str
    version: str
    required_for: frozenset[JobScope]
    dependencies: tuple[str, ...]

    def run(self, context: StageContext) -> StageResult:
        """Execute the stage against immutable input artifacts."""


class StageRegistry:
    """Validate and expose the registered stage set."""

    def __init__(self, stages: list[Stage] | tuple[Stage, ...] = ()) -> None:
        self._stages: dict[str, Stage] = {}
        for stage in stages:
            self.register(stage)

    def register(self, stage: Stage) -> None:
        if stage.name in self._stages:
            raise ValueError(f"duplicate stage: {stage.name}")
        if not stage.name or not stage.version:
            raise ValueError("stage name and version are required")
        self._stages[stage.name] = stage

    def get(self, name: str) -> Stage:
        try:
            return self._stages[name]
        except KeyError as exc:
            raise KeyError(f"unknown stage: {name}") from exc

    def names(self) -> tuple[str, ...]:
        return tuple(self._stages)

    def validate_order(self, names: list[str] | tuple[str, ...]) -> None:
        """Fail admission when a stage is ordered before its dependencies."""

        positions = {name: index for index, name in enumerate(names)}
        for name in names:
            stage = self.get(name)
            for dependency in getattr(stage, "dependencies", ()):
                if dependency not in positions:
                    raise ValueError(f"stage {name} is missing dependency {dependency}")
                if positions[dependency] >= positions[name]:
                    raise ValueError(f"stage {name} must run after dependency {dependency}")


def idempotency_key(stage: Stage, context: StageContext) -> str:
    """Build a stable key from stage code, input artifacts, and scope config."""

    identity = {
        "stage": stage.name,
        "version": stage.version,
        "scope": context.scope,
        "skip_sync": context.skip_sync,
        "tickers": sorted(set(context.tickers)),
        "inputs": sorted(context.upstream_artifact_ids),
        "configuration": dict(sorted(context.configuration.items())),
    }
    encoded = json.dumps(
        identity,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
