"""Versioned, editable valuation scenario assumptions.

The store is the source of truth for bull/base/bear assumptions. It seeds from
a bundled catalog on first load, can be edited through the settings API, and
is snapshotted into every research run so each valuation artifact stays
reproducible.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import ApiModel, Field

SEED_PATH = Path(__file__).with_name("valuation_assumptions_seed.json")


class ValuationScenario(ApiModel):
    revenue_cagr: float | None = None
    target_fcf_margin: float | None = None
    discount_rate: float | None = None
    exit_fcf_multiple: float | None = None
    share_cagr: float | None = None


class ValuationCompanyAssumptions(ApiModel):
    ticker: str
    name: str = ""
    source: str = "seed-v1"
    updated_at: datetime | None = None
    scenarios: dict[str, ValuationScenario] = Field(default_factory=dict)


class ValuationAssumptionsState(ApiModel):
    schema_version: int = 1
    as_of: str
    revision: int = 1
    companies: list[ValuationCompanyAssumptions] = Field(default_factory=list)
    history: list[ValuationAssumptionsHistoryEntry] = Field(default_factory=list)


class ValuationAssumptionsUpsertRequest(ApiModel):
    scenarios: dict[str, ValuationScenario]
    name: str | None = None
    source: str = "manual"


class ValuationAssumptionsHistoryEntry(ApiModel):
    entry_id: str
    ticker: str
    name: str = ""
    source: str = "manual"
    revision: int
    changed_at: datetime
    changes: dict[str, dict[str, Any]] = Field(default_factory=dict)


def _scenario_diff(
    before: dict[str, ValuationScenario] | None,
    after: dict[str, ValuationScenario],
) -> dict[str, dict[str, Any]]:
    before_dump = {
        name: scenario.model_dump(mode="json", by_alias=True)
        for name, scenario in (before or {}).items()
    }
    after_dump = {
        name: scenario.model_dump(mode="json", by_alias=True) for name, scenario in after.items()
    }
    changes: dict[str, dict[str, Any]] = {}
    for name in sorted(set(before_dump) | set(after_dump)):
        before_scenario = before_dump.get(name, {})
        after_scenario = after_dump.get(name, {})
        for field in (
            "revenueCagr",
            "targetFcfMargin",
            "discountRate",
            "exitFcfMultiple",
            "shareCagr",
        ):
            before_value = before_scenario.get(field)
            after_value = after_scenario.get(field)
            if before_value != after_value:
                changes[f"{name}.{field}"] = {
                    "before": before_value,
                    "after": after_value,
                }
    return changes


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
            )
            handle.write("\n")
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


class ValuationAssumptionsStore:
    """Read and update the versioned assumption catalog."""

    def __init__(self, data_root: Path, seed_path: Path | None = None) -> None:
        self.path = Path(data_root).expanduser().resolve() / "valuation_assumptions.json"
        self.seed_path = seed_path or SEED_PATH
        self._lock = threading.RLock()

    def load(self) -> ValuationAssumptionsState:
        with self._lock:
            if self.path.is_file():
                return ValuationAssumptionsState.model_validate_json(
                    self.path.read_text(encoding="utf-8")
                )
            if self.seed_path.is_file():
                return ValuationAssumptionsState.model_validate_json(
                    self.seed_path.read_text(encoding="utf-8")
                )
            return ValuationAssumptionsState(
                as_of=datetime.now(UTC).date().isoformat(),
                companies=[],
            )

    def save(self, state: ValuationAssumptionsState) -> None:
        with self._lock:
            _atomic_write(
                self.path,
                state.model_dump(mode="json", by_alias=True),
            )

    def upsert(
        self,
        ticker: str,
        request: ValuationAssumptionsUpsertRequest,
    ) -> ValuationAssumptionsState:
        ticker = ticker.upper()
        with self._lock:
            state = self.load()
            company = next(
                (item for item in state.companies if item.ticker == ticker),
                None,
            )
            before_scenarios = dict(company.scenarios) if company is not None else {}
            changes = _scenario_diff(before_scenarios, request.scenarios)
            if company is None:
                company = ValuationCompanyAssumptions(
                    ticker=ticker,
                    name=request.name or "",
                    source=request.source,
                    scenarios=request.scenarios,
                )
                state.companies.append(company)
            else:
                name_changed = request.name is not None and company.name != request.name
                if name_changed:
                    changes["name"] = {
                        "before": company.name,
                        "after": request.name,
                    }
                source_changed = company.source != request.source
                if source_changed:
                    changes["source"] = {
                        "before": company.source,
                        "after": request.source,
                    }
                company.name = request.name or company.name
                company.source = request.source
                company.scenarios = request.scenarios
                if not changes:
                    return state
            company.updated_at = datetime.now(UTC)
            state.as_of = datetime.now(UTC).date().isoformat()
            state.revision += 1
            if changes:
                state.history.append(
                    ValuationAssumptionsHistoryEntry(
                        entry_id=uuid.uuid4().hex,
                        ticker=ticker,
                        name=company.name,
                        source=request.source,
                        revision=state.revision,
                        changed_at=datetime.now(UTC),
                        changes=changes,
                    )
                )
                state.history = state.history[-500:]
            self.save(state)
            return state

    def history(self, limit: int = 100) -> list[ValuationAssumptionsHistoryEntry]:
        with self._lock:
            state = self.load()
            return list(reversed(state.history[-max(1, min(limit, 500)) :]))

    def to_snapshot_payload(self) -> dict[str, Any]:
        state = self.load()
        return {
            "schema_version": state.schema_version,
            "as_of": state.as_of,
            "revision": state.revision,
            "companies": [
                {
                    "ticker": item.ticker,
                    "name": item.name,
                    "source": item.source,
                    "updated_at": (
                        item.updated_at.isoformat() if item.updated_at is not None else None
                    ),
                    "scenarios": {
                        name: scenario.model_dump(mode="json", by_alias=True)
                        for name, scenario in item.scenarios.items()
                    },
                }
                for item in state.companies
            ],
        }


__all__ = [
    "SEED_PATH",
    "ValuationAssumptionsHistoryEntry",
    "ValuationAssumptionsState",
    "ValuationAssumptionsStore",
    "ValuationAssumptionsUpsertRequest",
    "ValuationCompanyAssumptions",
    "ValuationScenario",
]
