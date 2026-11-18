"""Page role contracts. Each role projects a pinned snapshot through its allowed tools."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime
from functools import lru_cache
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import RunContext
from pydantic_ai.usage import RunUsage

from ..models import ApiModel, JobRecord
from .deps import AssistantDeps, AssistantSnapshotReader
from .tools import Args

Source = Literal[
    "account",
    "broker",
    "holdings",
    "exposure",
    "market",
    "technical",
    "financials",
    "analysts",
    "disclosure",
    "review",
    "health",
    "calendar",
    "inference",
    "publisher",
]


class RoleContext(BaseModel):
    """Only role-specific, validated identifiers enter a reading."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ReadingEvidence(ApiModel):
    publisher: str | None = Field(default=None, max_length=80)
    source: Source
    tool: str
    arguments: dict[str, str] = Field(default_factory=dict)
    evidence_id: str


class LinkedObservation(ApiModel):
    zh: str
    en: str
    evidence: ReadingEvidence


class ReadingLine(LinkedObservation):
    section: str = ""
    variants: dict[str, LinkedObservation] = Field(default_factory=dict)


class RoleReading(ApiModel):
    role: str
    version: str
    as_of: datetime
    lines: list[ReadingLine]


class ReadingSnapshot:
    """Reuse immutable payloads across tools within one reading and release them together."""

    def __init__(self, store: AssistantSnapshotReader):
        self.load_manifest = store.load_manifest
        self.read_json = lru_cache(maxsize=24)(store.read_json)
        self.read_text = lru_cache(maxsize=8)(store.read_text)


@dataclass(frozen=True)
class RoleTools:
    deps: AssistantDeps
    allowed: frozenset[str]

    @classmethod
    def pinned(cls, deps: AssistantDeps, allowed: frozenset[str]) -> RoleTools:
        return cls(replace(deps, store=ReadingSnapshot(deps.store)), allowed)

    def read(self, tool: Callable, args: Args) -> dict:
        if tool.__name__ not in self.allowed:
            raise ValueError("Tool outside the role's read scope")
        return tool(RunContext(deps=self.deps, model=None, usage=RunUsage()), args)


@dataclass(frozen=True)
class BriefTarget:
    context: RoleContext
    slot: str


@dataclass(frozen=True)
class PageRole:
    id: str
    page: str
    allowed_tools: frozenset[str]
    context_schema: type[RoleContext]
    prompt: str
    facts: Callable[[RoleTools, Any], list[ReadingLine]]
    scheduled: Callable[[JobRecord], list[BriefTarget]] | None = None
    weekly_fold: bool = False
    # Event-driven digests can inspect a pinned publication, enumerate affected
    # objects and key each one by its material data (e.g. earnings or outcomes).
    publication_targets: Callable[[JobRecord, RoleTools], list[BriefTarget]] | None = None
    data_version: Callable[[RoleTools, Any], str] | None = None

    @property
    def is_digest(self) -> bool:
        return bool(self.scheduled or self.publication_targets or self.weekly_fold)

    def object_key(self, context: RoleContext) -> str:
        return json.dumps(context.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def role_registry() -> dict[str, PageRole]:
    from .overview_roles import OVERVIEW_ROLES

    return {role.id: role for role in OVERVIEW_ROLES}
