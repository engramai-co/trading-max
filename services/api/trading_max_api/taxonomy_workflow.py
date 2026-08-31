"""Persist and execute the audited growing-taxonomy workflow."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, ClassVar

import httpx
from trading_max.application import RawTaxonomyCatalogProvider
from trading_max.domain import ArtifactQuality, InstrumentId
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.research import (
    GrowingTaxonomy,
    TaxonomyCatalog,
    TaxonomyWorkflowDecision,
    TaxonomyWorkflowEngine,
)

from .watchlist import WatchlistStore


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


class ConfiguredTaxonomyJudge:
    """Use the already-resolved provider route for one strict JSON judgment."""

    ROLE_RULES: ClassVar[dict[str, str]] = {
        "fit-judge": "Select the closest existing theme by positive semantic fit.",
        "boundary-judge": "Reject assignments that would weaken a theme's inclusion/exclusion boundary.",
        "counterexample-judge": "Actively search for a better existing theme or a decisive counterexample.",
        "candidate-proposer": "Propose one durable bilingual research theme, not a company-specific label.",
        "candidate-critic": "Try to collapse the proposal into an existing theme; revise or reject weak proposals.",
        "stability-judge": "Test whether the candidate has stable long-horizon economic meaning.",
        "novelty-judge": "Test whether the candidate is genuinely distinct from every existing theme.",
        "utility-judge": "Test whether the candidate improves research comparison or risk understanding.",
    }

    def __init__(self, provider: Any, *, timeout: float = 90.0) -> None:
        self.provider = provider
        self.timeout = timeout

    def __call__(
        self,
        stage: str,
        role: str,
        prompt_version: str,
        payload: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        schema_rules = {
            "existing-assignment": (
                "Return verdict (assign_existing|no_match|manual_review), taxonomyId or null, "
                "alternativeTaxonomyId or null, confidence 0..1, alternativeConfidence 0..1, rationale."
            ),
            "candidate-proposal": (
                "Return verdict (propose|manual_review), themeId kebab-case, labelZh, labelEn, "
                "descriptionZh, descriptionEn, inclusionCriteria[], exclusionCriteria[], "
                "nearestExistingTaxonomyId or null, confidence 0..1, rationale."
            ),
            "candidate-critique": (
                "Return verdict (accept|revise|reject|assign_existing), taxonomyId or null, "
                "confidence 0..1, rationale. If revising, also return candidate with the full "
                "proposal fields."
            ),
            "admission": (
                "Return outcome/verdict (create_new|assign_existing|merge_with_existing|"
                "remain_pending|manual_review), taxonomyId or null, confidence 0..1, rationale."
            ),
        }[stage]
        api_key = str(getattr(self.provider, "api_key", ""))
        base_url = str(getattr(self.provider, "base_url", "")).rstrip("/")
        model = str(getattr(self.provider, "model", ""))
        if not api_key or not base_url or not model:
            return {
                "verdict": "manual_review",
                "confidence": 0,
                "rationale": "Configured taxonomy provider is unavailable.",
            }
        system = (
            "You are one independent pass in Trading Max's audited growing taxonomy. "
            "GICS is immutable reference metadata and must not be rewritten. Never fabricate "
            "business facts. Use only the evidence and taxonomy supplied. "
            f"Role: {role}. {self.ROLE_RULES[role]} {schema_rules} "
            "Return exactly one JSON object and no markdown."
        )
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system},
                            {
                                "role": "user",
                                "content": json.dumps(
                                    {"promptVersion": prompt_version, **dict(payload)},
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                            },
                        ],
                        "response_format": {"type": "json_object"},
                        "thinking": {"type": "disabled"},
                        "temperature": 0,
                        "max_tokens": 2_000,
                    },
                )
                response.raise_for_status()
                body = response.json()
                content = body["choices"][0]["message"]["content"]
                decoded = json.loads(content)
                if not isinstance(decoded, dict):
                    raise ValueError("taxonomy judgment is not an object")
                return decoded
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            return {
                "verdict": "manual_review",
                "confidence": 0,
                "rationale": f"Taxonomy provider pass failed: {type(exc).__name__}",
            }


class TaxonomyWorkflowManager:
    """Run decisions after a durable research snapshot and persist their audit trail."""

    def __init__(
        self,
        data_root: Path,
        watchlist: WatchlistStore,
        artifacts: ContentAddressedArtifactStore,
    ) -> None:
        self.data_root = data_root.expanduser().resolve()
        self.catalog_path = self.data_root / "taxonomy.json"
        self.audit_root = self.data_root / "taxonomy-workflows"
        self.watchlist = watchlist
        self.artifacts = artifacts

    def _catalog(self) -> TaxonomyCatalog:
        catalog, _warnings = RawTaxonomyCatalogProvider(self.data_root).load()
        return GrowingTaxonomy(catalog).catalog

    def record_pending(self, item: Any, *, provider_available: bool) -> None:
        """Persist the admission state immediately; never delay watchlist creation."""

        if item.taxonomy_status in {"assigned", "needs-review"}:
            return
        if item.taxonomy_status == "classifying" and item.taxonomy_decision_id:
            return
        catalog = self._catalog()
        decision_id = f"taxonomy-{item.ticker.lower()}-{secrets.token_hex(8)}"
        instrument = InstrumentId(
            ticker=item.ticker,
            exchange=item.exchange,
            bloomberg_ticker=item.bloomberg_ticker,
            figi=item.figi,
        )
        engine = TaxonomyWorkflowEngine(catalog)
        decision = engine.run(
            decision_id=decision_id,
            instrument=instrument,
            evidence={"source": "watchlist-add", "name": item.name},
            judge=None,
        )
        if provider_available:
            decision.status = "classifying"
            decision.rationale = "Classification is queued behind the durable research snapshot."
        audit_path = self.audit_root / item.ticker / f"{decision.decision_id}.json"
        _atomic_json(audit_path, decision.model_dump(mode="json", by_alias=True))
        self.watchlist.apply_taxonomy_workflow(decision, catalog)

    @staticmethod
    def _evidence(context: Mapping[str, Any], ticker: str) -> dict[str, Any]:
        instruments = context.get("instruments")
        instrument = (
            next(
                (
                    dict(item)
                    for item in instruments
                    if isinstance(instruments, list)
                    and isinstance(item, Mapping)
                    and str(item.get("ticker") or "").upper() == ticker
                ),
                {},
            )
            if isinstance(instruments, list)
            else {}
        )
        return {
            "instrument": instrument,
            "snapshotRunId": context.get("snapshotRunId"),
            "dataAsOf": context.get("dataAsOf"),
        }

    @staticmethod
    def _failure_decision(
        *,
        decision_id: str,
        instrument: InstrumentId,
        taxonomy_version: int,
        message: str,
    ) -> TaxonomyWorkflowDecision:
        payload = {
            "instrument": instrument.model_dump(mode="json", by_alias=True),
            "taxonomyVersion": taxonomy_version,
            "error": message,
        }
        import hashlib

        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return TaxonomyWorkflowDecision(
            decision_id=decision_id,
            instrument=instrument,
            taxonomy_version=taxonomy_version,
            status="needs-review",
            outcome="manual_review",
            input_hash=digest,
            rationale=message,
        )

    def execute(self, context: Mapping[str, Any], provider: Any | None) -> list[str]:
        artifact_ids: list[str] = []
        provider_available = provider is not None and not bool(getattr(provider, "fake", False))
        provider_name = str(getattr(provider, "name", "deterministic"))
        model = str(getattr(provider, "model", "none"))
        for item in self.watchlist.items():
            catalog = self._catalog()
            if item.taxonomy_status == "assigned" or item.taxonomy_status == "needs-review":
                continue
            if (
                item.taxonomy_status == "unclassified"
                and item.taxonomy_version is None
                and item.taxonomy_decision_id
                and not provider_available
            ):
                continue
            if (
                item.taxonomy_status == "unclassified"
                and item.taxonomy_version is not None
                and item.taxonomy_version >= catalog.taxonomy_version
            ):
                continue
            decision_id = f"taxonomy-{item.ticker.lower()}-{secrets.token_hex(8)}"
            instrument = InstrumentId(
                ticker=item.ticker,
                exchange=item.exchange,
                bloomberg_ticker=item.bloomberg_ticker,
                figi=item.figi,
            )
            try:
                engine = TaxonomyWorkflowEngine(catalog)
                judge = ConfiguredTaxonomyJudge(provider) if provider_available else None
                decision = engine.run(
                    decision_id=decision_id,
                    instrument=instrument,
                    evidence=self._evidence(context, item.ticker),
                    judge=judge,
                    provider=provider_name if provider_available else "deterministic",
                    model=model if provider_available else "none",
                )
                if decision.status == "assigned" and decision.assigned_taxonomy_id:
                    growing = GrowingTaxonomy(catalog)
                    candidate = decision.candidate
                    applied = growing.apply_llm(
                        instrument=instrument,
                        theme_id=decision.assigned_taxonomy_id,
                        label=decision.assigned_label_en or decision.assigned_taxonomy_id,
                        confidence=decision.confidence,
                        rationale=decision.rationale,
                        create_theme=decision.outcome == "create_new",
                        theme_label_zh=candidate.label_zh if candidate else None,
                        theme_label_en=candidate.label_en if candidate else None,
                        theme_description_zh=candidate.description_zh if candidate else None,
                        theme_description_en=candidate.description_en if candidate else None,
                        theme_inclusion_criteria=(
                            candidate.inclusion_criteria if candidate else None
                        ),
                        theme_exclusion_criteria=(
                            candidate.exclusion_criteria if candidate else None
                        ),
                        model=model,
                        workflow_decision_id=decision.decision_id,
                        input_hash=decision.input_hash,
                    )
                    if applied.accepted:
                        catalog = growing.catalog
                        decision.taxonomy_version = catalog.taxonomy_version
                    else:
                        decision.status = "needs-review"
                        decision.outcome = "manual_review"
                        decision.assigned_taxonomy_id = None
                        decision.rationale = applied.warning or "Taxonomy admission was rejected."
                _atomic_json(
                    self.catalog_path,
                    catalog.model_dump(mode="json", by_alias=True),
                )
            except Exception as exc:  # audit failures rather than lose pending state
                decision = self._failure_decision(
                    decision_id=decision_id,
                    instrument=instrument,
                    taxonomy_version=catalog.taxonomy_version,
                    message=f"Workflow failed: {type(exc).__name__}: {exc}",
                )
            audit_payload = decision.model_dump(mode="json", by_alias=True)
            audit_path = self.audit_root / item.ticker / f"{decision.decision_id}.json"
            _atomic_json(audit_path, audit_payload)
            stored = self.artifacts.put_json(
                key=f"taxonomy-workflows/{item.ticker}/{decision.decision_id}.json",
                payload=audit_payload,
                kind="taxonomy_decision",
                as_of=str(context.get("snapshotRunId") or "") or None,
                producer_version="growing-taxonomy-3-2-3-v1",
                quality=ArtifactQuality(
                    status="verified" if decision.status == "assigned" else "warning",
                    coverage=f"{len(decision.judgments)} judgments",
                    warnings=[] if decision.status == "assigned" else [decision.rationale],
                ),
            )
            artifact_ids.append(stored.ref.artifact_id)
            self.watchlist.apply_taxonomy_workflow(decision, catalog)
        return artifact_ids


__all__ = ["ConfiguredTaxonomyJudge", "TaxonomyWorkflowManager"]
