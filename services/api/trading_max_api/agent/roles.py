"""Page role contracts. Each role projects a pinned snapshot through its allowed tools."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime
from functools import lru_cache
from typing import Any, ClassVar, Literal, get_type_hints

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import RunContext
from pydantic_ai.usage import RunUsage

from ..models import ApiModel, JobRecord
from .deps import AssistantDeps, AssistantSnapshotReader, ToolBindings, bind_arguments

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
    variant_fields: ClassVar[frozenset[str]] = frozenset()


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
    snapshot_id: str | None = None
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
    role: PageRole | None = None
    context: RoleContext | None = None
    _evidence: dict[tuple[str, str], dict[str, str | None]] = field(
        default_factory=dict, repr=False
    )

    @classmethod
    def pinned(cls, deps: AssistantDeps, allowed: frozenset[str]) -> RoleTools:
        return cls(replace(deps, store=ReadingSnapshot(deps.store)), allowed)

    def for_variant(self, context: RoleContext) -> RoleTools:
        """Read a named display variant through the same role on the same publication."""
        if self.role is None or self.context is None:
            raise ValueError("A variant requires a registered page role")
        fixed = self.context.model_dump(exclude=self.context.variant_fields)
        if context.model_dump(exclude=self.context.variant_fields) != fixed:
            raise ValueError("A variant cannot change this part of the selected object")
        return replace(self, deps=self.role.bind(self.deps, context), context=context)

    def read(self, tool: Callable, args: BaseModel | dict) -> dict:
        name = tool.__name__
        bindings = self.deps.role_bindings
        if name not in self.allowed or (bindings is not None and name not in bindings):
            raise ValueError("Tool outside the role's read scope")
        if bindings is not None or isinstance(args, dict):
            supplied = (
                args if isinstance(args, dict) else args.model_dump(mode="json", exclude_unset=True)
            )
            schema = get_type_hints(tool)["args"]
            effective = bind_arguments(supplied, bindings[name] if bindings else {}, schema)
            args = schema.model_validate_json(json.dumps(effective))
        result = tool(RunContext(deps=self.deps, model=None, usage=RunUsage()), args)
        if bindings is not None:
            bound = self.deps.bound_evidence(name)
            key = (name, result["evidence_id"])
            if self._evidence.setdefault(key, bound) != bound:
                raise ValueError("Ambiguous tool evidence for the selected object")
            result = {**result, "bound_arguments": bound}
        return result

    def attach_evidence(self, facts: list[ReadingLine]) -> None:
        if self.role is None or self.role.tool_bindings is None:
            return
        for line in facts:
            for observation in (line, *line.variants.values()):
                ref = observation.evidence
                bound = self._evidence[(ref.tool, ref.evidence_id)]
                if observation is line and bound != self.deps.bound_evidence(ref.tool):
                    raise ValueError("Primary observation belongs to another selection")
                ref.arguments = {k: v for k, v in (ref.arguments | bound).items() if v is not None}


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

    tool_bindings: Callable[[Any, str | None], ToolBindings] | None = None

    def bind(self, deps: AssistantDeps, context: RoleContext) -> AssistantDeps:
        selected = self.context_schema.model_validate(context.model_dump())
        bindings = (
            self.tool_bindings(selected, deps.snapshot_id)
            if self.tool_bindings
            else {tool: {} for tool in self.allowed_tools}
        )
        if bindings.keys() - self.allowed_tools:
            raise ValueError("Selection includes a tool outside the role's read scope")
        for arguments in bindings.values():
            for name in ("snapshotId", "snapshot_id"):
                if name in arguments and arguments[name] != deps.snapshot_id:
                    raise ValueError("A binding cannot change the selected publication")
        return replace(deps, role_bindings=bindings)

    def reader(self, deps: AssistantDeps, context: RoleContext) -> RoleTools:
        if self.tool_bindings is None:
            return RoleTools.pinned(deps, self.allowed_tools)
        pinned = RoleTools.pinned(self.bind(deps, context), self.allowed_tools)
        return replace(pinned, role=self, context=context)

    @property
    def cache_id(self) -> str:
        # Readings published before argument binding carry no proof of their selection.
        return ("bound:" if self.tool_bindings else "") + self.id

    @property
    def is_digest(self) -> bool:
        return bool(self.scheduled or self.publication_targets or self.weekly_fold)

    def object_key(self, context: RoleContext) -> str:
        return json.dumps(context.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def role_registry() -> dict[str, PageRole]:
    from .overview_roles import OVERVIEW_ROLES

    return {role.id: role for role in OVERVIEW_ROLES}
