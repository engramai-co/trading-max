"""Versioned taxonomy and provider-crosswalk adapters.

The security universe is discovered dynamically and is never encoded here.
GICS itself is a finite external standard, so its hierarchy and provider
crosswalk are loaded as versioned reference data rather than Python enums or
ticker maps.

Operators with licensed issuer-level classifications can continue to publish
``official`` assignments into the security master.  The bundled Yahoo Finance
adapter only derives classifications from business-profile metadata and
preserves that weaker provenance in every result.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .security_master import GicsClassification

_PROFILE_KEY = re.compile(r"[^a-z0-9]+")
_DEFAULT_DATA_ROOT = Path(__file__).with_name("data")
_DEFAULT_NODES_PATH = _DEFAULT_DATA_ROOT / "gics-nodes-2026.json"
_DEFAULT_CROSSWALK_PATH = _DEFAULT_DATA_ROOT / "yahoo-profile-crosswalk-2026.08.2.json"


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class _ReferenceModel(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True)


class _NodeRecord(_ReferenceModel):
    sector_code: str
    sector_name: str
    industry_group_code: str
    industry_group_name: str
    industry_code: str
    industry_name: str
    sub_industry_code: str
    sub_industry_name: str
    label_zh: str

    @model_validator(mode="after")
    def validate_hierarchy(self) -> _NodeRecord:
        dimensions = (
            ("sector", self.sector_code, 2),
            ("industry group", self.industry_group_code, 4),
            ("industry", self.industry_code, 6),
            ("sub-industry", self.sub_industry_code, 8),
        )
        for label, code, length in dimensions:
            if len(code) != length or not code.isdigit():
                raise ValueError(f"invalid {label} code: {code!r}")
        if not (
            self.sub_industry_code.startswith(self.industry_code)
            and self.industry_code.startswith(self.industry_group_code)
            and self.industry_group_code.startswith(self.sector_code)
        ):
            raise ValueError(f"inconsistent GICS hierarchy for {self.sub_industry_code}")
        return self


class _NodeDataset(_ReferenceModel):
    schema_version: int
    taxonomy: Literal["GICS"]
    taxonomy_version: str
    dataset_id: str
    scope: str
    provenance: dict[str, str] = Field(default_factory=dict)
    nodes: list[_NodeRecord]

    @field_validator("nodes")
    @classmethod
    def unique_nodes(cls, nodes: list[_NodeRecord]) -> list[_NodeRecord]:
        codes = [node.sub_industry_code for node in nodes]
        if len(codes) != len(set(codes)):
            raise ValueError("duplicate GICS sub-industry code")
        return nodes


class _CrosswalkRecord(_ReferenceModel):
    profile_key: str
    target_code: str
    confidence: float = Field(ge=0, le=1)


class _TitleCrosswalkRecord(_ReferenceModel):
    sector: str
    industry: str
    target_code: str
    confidence: float = Field(ge=0, le=1)


class _CrosswalkDataset(_ReferenceModel):
    schema_version: int
    provider: str
    crosswalk_version: str
    taxonomy: Literal["GICS"]
    taxonomy_version: str
    match_policy: str
    mappings: list[_CrosswalkRecord]
    title_mappings: list[_TitleCrosswalkRecord] = Field(default_factory=list)

    @field_validator("mappings")
    @classmethod
    def unique_profile_keys(
        cls,
        mappings: list[_CrosswalkRecord],
    ) -> list[_CrosswalkRecord]:
        keys = [row.profile_key for row in mappings]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate provider profile key")
        return mappings


@dataclass(frozen=True, slots=True)
class GicsNode:
    sector_code: str
    sector_name: str
    industry_group_code: str
    industry_group_name: str
    industry_code: str
    industry_name: str
    sub_industry_code: str
    sub_industry_name: str
    label_zh: str


@dataclass(frozen=True, slots=True)
class _ProfileMatch:
    target_code: str
    confidence: float


@dataclass(frozen=True, slots=True)
class TaxonomyReference:
    taxonomy_version: str
    provider: str
    crosswalk_version: str
    nodes: dict[str, GicsNode]
    profile_crosswalk: dict[str, _ProfileMatch]
    title_crosswalk: dict[tuple[str, str], _ProfileMatch]


def normalize_profile_key(value: str | None) -> str:
    return _PROFILE_KEY.sub("-", (value or "").strip().lower()).strip("-")


def _read_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"reference dataset must be a JSON object: {path}")
    return payload


def _configured_path(environment_key: str, fallback: Path) -> Path:
    configured = os.environ.get(environment_key, "").strip()
    return Path(configured).expanduser().resolve() if configured else fallback


@lru_cache(maxsize=1)
def taxonomy_reference() -> TaxonomyReference:
    """Load and validate the configured taxonomy data exactly once per process."""

    nodes_path = _configured_path(
        "TRADING_MAX_GICS_NODES_PATH",
        _DEFAULT_NODES_PATH,
    )
    crosswalk_path = _configured_path(
        "TRADING_MAX_GICS_CROSSWALK_PATH",
        _DEFAULT_CROSSWALK_PATH,
    )
    node_dataset = _NodeDataset.model_validate(_read_object(nodes_path))
    crosswalk_dataset = _CrosswalkDataset.model_validate(_read_object(crosswalk_path))
    if crosswalk_dataset.taxonomy_version != node_dataset.taxonomy_version:
        raise ValueError("provider crosswalk taxonomy version does not match the node dataset")

    nodes = {row.sub_industry_code: GicsNode(**row.model_dump()) for row in node_dataset.nodes}

    def match(target_code: str, confidence: float) -> _ProfileMatch:
        if target_code not in nodes:
            raise ValueError(f"provider crosswalk references unknown GICS node {target_code}")
        return _ProfileMatch(target_code=target_code, confidence=confidence)

    profile_crosswalk = {
        normalize_profile_key(row.profile_key): match(
            row.target_code,
            row.confidence,
        )
        for row in crosswalk_dataset.mappings
    }
    title_crosswalk = {
        (row.sector.strip().casefold(), row.industry.strip().casefold()): match(
            row.target_code,
            row.confidence,
        )
        for row in crosswalk_dataset.title_mappings
    }
    return TaxonomyReference(
        taxonomy_version=node_dataset.taxonomy_version,
        provider=crosswalk_dataset.provider,
        crosswalk_version=crosswalk_dataset.crosswalk_version,
        nodes=nodes,
        profile_crosswalk=profile_crosswalk,
        title_crosswalk=title_crosswalk,
    )


def gics_node_for_code(code: str) -> GicsNode | None:
    return taxonomy_reference().nodes.get(code)


def classification_for_code(
    code: str,
    *,
    source: str,
    method: Literal["official", "derived", "manual"] = "derived",
    confidence: float = 0.9,
    as_of: str = "",
) -> GicsClassification | None:
    node = gics_node_for_code(code)
    if node is None:
        return None
    return GicsClassification(
        sector_code=node.sector_code,
        sector_name=node.sector_name,
        industry_group_code=node.industry_group_code,
        industry_group_name=node.industry_group_name,
        industry_code=node.industry_code,
        industry_name=node.industry_name,
        sub_industry_code=node.sub_industry_code,
        sub_industry_name=node.sub_industry_name,
        source=source,
        version=taxonomy_reference().taxonomy_version,
        as_of=as_of,
        method=method,
        confidence=confidence,
    )


def classification_for_profile(
    *,
    sector: str | None,
    industry: str | None,
    industry_key: str | None = None,
    as_of: str = "",
) -> GicsClassification | None:
    """Derive a classification from provider business metadata, never identity."""

    reference = taxonomy_reference()
    key = normalize_profile_key(industry_key or industry)
    matched = reference.profile_crosswalk.get(key)
    if matched is None and sector and industry:
        matched = reference.title_crosswalk.get(
            (sector.strip().casefold(), industry.strip().casefold())
        )
    if matched is None:
        return None
    return classification_for_code(
        matched.target_code,
        source=(f"{reference.provider}-profile:{reference.crosswalk_version}"),
        method="derived",
        confidence=matched.confidence,
        as_of=as_of,
    )


def taxonomy_versions() -> tuple[str, str]:
    reference = taxonomy_reference()
    return reference.taxonomy_version, reference.crosswalk_version


GICS_VERSION, PROFILE_CROSSWALK_VERSION = taxonomy_versions()


__all__ = [
    "GICS_VERSION",
    "PROFILE_CROSSWALK_VERSION",
    "GicsNode",
    "TaxonomyReference",
    "classification_for_code",
    "classification_for_profile",
    "gics_node_for_code",
    "normalize_profile_key",
    "taxonomy_reference",
    "taxonomy_versions",
]
