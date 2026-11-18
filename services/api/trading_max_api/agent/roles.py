"""Page role contracts. Each role projects a pinned snapshot through its allowed tools."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import RunContext
from pydantic_ai.usage import RunUsage

from ..models import ApiModel, JobRecord
from .deps import AssistantDeps
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
]


class RoleContext(BaseModel):
    """Only role-specific, validated identifiers enter a reading."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ReadingEvidence(ApiModel):
    source: Source
    tool: str
    arguments: dict[str, str] = Field(default_factory=dict)
    evidence_id: str


class ReadingLine(ApiModel):
    zh: str
    en: str
    section: str = ""
    evidence: ReadingEvidence


class RoleReading(ApiModel):
    role: str
    version: str
    as_of: datetime
    lines: list[ReadingLine]


@dataclass(frozen=True)
class RoleTools:
    deps: AssistantDeps
    allowed: frozenset[str]

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

    def object_key(self, context: RoleContext) -> str:
        return json.dumps(context.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def role_registry() -> dict[str, PageRole]:
    from .overview_roles import OVERVIEW_ROLES

    return {role.id: role for role in OVERVIEW_ROLES}
