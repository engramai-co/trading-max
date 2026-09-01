"""Publish deterministic seven-layer historical reviews for Invest and ISA."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pandas as pd

from trading_max.analytics.account_review import build_account_review
from trading_max.analytics.ledger import (
    load_transactions,
    reconstruct_campaigns,
    transaction_marker_rows,
)
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.ingestion.brokers.trading212 import latest_export_path

from .errors import StageExecutionError
from .stages import StageContext, StageResult


class AccountReviewStage:
    """Bind existing authoritative lenses into one review artifact."""

    name = "accounts.review"
    version = "account-review-stage-v2"
    required_for = frozenset({"all", "accounts"})
    dependencies = (
        "accounts.snapshot",
        "portfolio.lookthrough",
        "accounts.nav",
        "accounts.performance",
    )

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts

    def _json(
        self,
        context: StageContext,
        key: str,
    ) -> tuple[dict[str, Any], str, tuple[str, ...]]:
        for artifact_id in reversed(context.upstream_artifact_ids):
            try:
                stored = self.artifacts.get_json(artifact_id)
            except (FileNotFoundError, RuntimeError):
                continue
            if stored.ref.key == key:
                return (
                    stored.payload,
                    stored.ref.artifact_id,
                    self._quality_warnings(key, stored.ref.quality),
                )
        raise StageExecutionError(
            "account.review_dependency_missing",
            f"missing upstream artifact {key}",
        )

    def _csv(
        self,
        context: StageContext,
        key: str,
    ) -> tuple[pd.DataFrame, str, tuple[str, ...]]:
        for artifact_id in reversed(context.upstream_artifact_ids):
            try:
                stored = self.artifacts.get_bytes(artifact_id)
            except (FileNotFoundError, RuntimeError):
                continue
            if stored.ref.key != key:
                continue
            try:
                frame = pd.read_csv(io.StringIO(stored.path.read_text(encoding="utf-8")))
            except Exception as exc:
                raise StageExecutionError(
                    "account.review_nav_invalid",
                    f"{key}: {exc}",
                ) from exc
            return (
                frame,
                stored.ref.artifact_id,
                self._quality_warnings(key, stored.ref.quality),
            )
        raise StageExecutionError(
            "account.review_dependency_missing",
            f"missing upstream artifact {key}",
        )

    def _transactions(self, profile: str) -> pd.DataFrame:
        path = latest_export_path(profile, data_root=self.state_root / "trading212")
        if path is None:
            raise StageExecutionError(
                "account.review_ledger_missing",
                f"no managed Trading 212 export for {profile}",
            )
        try:
            return load_transactions([path])
        except Exception as exc:
            raise StageExecutionError(
                "account.review_ledger_invalid",
                f"{profile}: {exc}",
            ) from exc

    @staticmethod
    def _classification_by_ticker(lookthrough: dict[str, Any]) -> dict[str, dict[str, str]]:
        unavailable_labels = {
            "",
            "unknown",
            "unclassified",
            "other markets",
            "pending classification",
            "not gics applicable",
        }
        result: dict[str, dict[str, str]] = {}
        for row in lookthrough.get("positions", []):
            if not isinstance(row, dict):
                continue
            ticker = str(row.get("ticker") or "").strip().upper()
            if not ticker:
                continue
            classification: dict[str, str] = {}
            country = str(row.get("country") or "").strip()
            if country.lower() not in unavailable_labels:
                classification["country"] = country
            gics = row.get("gics")
            nested_gics = gics if isinstance(gics, dict) else {}
            industry = str(
                row.get("industry")
                or row.get("sector")
                or nested_gics.get("sectorName")
                or nested_gics.get("sector_name")
                or ""
            ).strip()
            if industry.lower() not in unavailable_labels:
                classification["industry"] = industry
            if classification:
                result[ticker] = classification
        return result

    @staticmethod
    def _quality_warnings(
        key: str,
        quality: ArtifactQuality,
    ) -> tuple[str, ...]:
        warnings = [f"{key}: {warning}" for warning in quality.warnings]
        if quality.status != "verified" and not warnings:
            warnings.append(f"{key}: upstream quality is {quality.status}")
        return tuple(warnings)

    @staticmethod
    def _review_warnings(code: str, review: dict[str, Any]) -> list[str]:
        warnings: list[str] = []
        section_names = (
            "money_outcome",
            "strategy_risk",
            "phases",
            "realised_trade_quality",
            "attribution",
            "structural_diagnostics",
            "ending_risk",
        )
        for name in section_names:
            section = review.get(name)
            if not isinstance(section, dict):
                warnings.append(f"{code}: {name} is missing from the deterministic review")
                continue
            status = str(section.get("status") or "unavailable")
            reason = str(section.get("unavailable_reason") or "").strip()
            if status == "unavailable":
                warnings.append(f"{code}: {name} unavailable: {reason or 'reason not supplied'}")
                continue
            if status == "partial":
                partial_reasons = section.get("partial_reasons")
                if isinstance(partial_reasons, list) and partial_reasons:
                    warnings.extend(
                        f"{code}: {name} partial: {reason}"
                        for reason in partial_reasons
                        if str(reason).strip()
                    )
                elif reason:
                    warnings.append(f"{code}: {name} partial: {reason}")
                else:
                    warnings.append(f"{code}: {name} is partially available")
            metric_reasons = section.get("metric_unavailable_reasons")
            if isinstance(metric_reasons, dict):
                warnings.extend(
                    f"{code}: {name}.{metric} unavailable: {metric_reason}"
                    for metric, metric_reason in metric_reasons.items()
                    if str(metric_reason).strip()
                )

        ending_risk = review.get("ending_risk")
        exposures = ending_risk.get("exposures") if isinstance(ending_risk, dict) else None
        if isinstance(exposures, dict):
            for dimension, section in exposures.items():
                if not isinstance(section, dict) or section.get("status") != "unavailable":
                    continue
                reason = str(section.get("unavailable_reason") or "reason not supplied")
                warnings.append(f"{code}: ending_risk.{dimension} unavailable: {reason}")
        return list(dict.fromkeys(warnings))

    def run(self, context: StageContext) -> StageResult:
        lookthrough, lookthrough_id, lookthrough_warnings = self._json(
            context,
            "account/lookthrough_metrics.json",
        )
        classifications = self._classification_by_ticker(lookthrough)
        reviews: dict[str, dict[str, Any]] = {}
        positions_by_account: dict[str, list[dict[str, Any]]] = {}
        transactions_by_account: dict[str, pd.DataFrame] = {}
        dependencies = [lookthrough_id]
        warnings: list[str] = list(lookthrough_warnings)

        for code, profile, kind in (
            ("A", "invest", "invest"),
            ("B", "isa", "isa"),
        ):
            account, account_id, account_warnings = self._json(
                context,
                f"account/{profile}.json",
            )
            performance, performance_id, performance_warnings = self._json(
                context,
                f"account/performance_{code.lower()}.json",
            )
            nav, nav_id, nav_warnings = self._csv(
                context,
                f"account/nav/daily_nav_{code.lower()}.csv",
            )
            warnings.extend(
                f"{code}: {warning}"
                for warning in (*account_warnings, *performance_warnings, *nav_warnings)
            )
            transactions = self._transactions(profile)
            transactions_by_account[profile] = transactions
            campaigns, _ = reconstruct_campaigns(transactions)
            for campaign in campaigns:
                classification = classifications.get(
                    str(campaign.get("Ticker") or "").strip().upper(),
                    {},
                )
                if classification.get("industry"):
                    campaign["Industry"] = classification["industry"]
                if classification.get("country"):
                    campaign["Country"] = classification["country"]
            positions = []
            for raw in account.get("positions", []):
                if not isinstance(raw, dict):
                    continue
                position = dict(raw)
                position.update(
                    classifications.get(str(raw.get("ticker") or "").strip().upper(), {})
                )
                positions.append(position)
            positions_by_account[profile] = positions
            review = build_account_review(
                account_code=code,
                account_kind=kind,
                transactions=transactions,
                campaigns=campaigns,
                nav_money_series=nav,
                ending_holdings=positions,
                strategy_risk=performance,
                provenance={
                    "account_artifact_id": account_id,
                    "nav_artifact_id": nav_id,
                    "performance_artifact_id": performance_id,
                    "lookthrough_artifact_id": lookthrough_id,
                    "broker_profile": profile,
                },
            )
            reviews[code] = review
            warnings.extend(f"{code}: {warning}" for warning in review.get("warnings", []))
            warnings.extend(self._review_warnings(code, review))
            dependencies.extend([account_id, nav_id, performance_id])

        warnings = list(dict.fromkeys(warnings))

        stored = self.artifacts.put_json(
            key="account/account_reviews.json",
            payload={
                "schema_version": 1,
                "calculation_version": "account-review-v1",
                "accounts": reviews,
            },
            kind="account_review",
            producer_version=self.version,
            dependency_artifact_ids=sorted(set(dependencies)),
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage="2/2 investable accounts",
                warnings=warnings,
            ),
        )
        marker_rows = transaction_marker_rows(
            transactions_by_account,
            (position for positions in positions_by_account.values() for position in positions),
        )
        marker_artifact = self.artifacts.put_json(
            key="account/trade_markers.json",
            payload={
                "schema_version": 1,
                "calculation_version": "trade-markers-v1",
                "rows": marker_rows,
            },
            kind="trade_markers",
            producer_version=self.version,
            dependency_artifact_ids=sorted(set(dependencies)),
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(marker_rows)} marker days",
            ),
        )
        return StageResult(
            artifacts=(stored.ref, marker_artifact.ref),
            warnings=tuple(warnings),
        )


__all__ = ["AccountReviewStage"]
