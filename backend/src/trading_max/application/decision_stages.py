"""Publish per-account decision reviews: each buy and sell against what followed."""

from __future__ import annotations

import json
from contextlib import suppress
from pathlib import Path
from typing import Any

import pandas as pd

from trading_max.analytics.decision_prices import CachedDailyHistory, resolve_decision_prices
from trading_max.analytics.decision_review import CALCULATION_VERSION, build_decision_review
from trading_max.analytics.fx import FxResolver, HistoricalFxResolver
from trading_max.analytics.historical_nav import HistoryLoader, _trade_columns
from trading_max.analytics.ledger import (
    load_transactions,
    normalize_transactions_gbp,
    reconstruct_campaigns,
)
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.ingestion.brokers.trading212 import latest_export_path

from .account_selection import selected_accounts
from .stages import StageContext, StageResult

DECISIONS_KEY = "account/decisions.json"


class AccountDecisionStage:
    """Score buys and sells; a missing price source marks that account unavailable."""

    name = "accounts.decisions"
    version = "decision-review-stage-v1"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        *,
        history_loader: HistoryLoader | None = None,
        fx_resolver: FxResolver | None = None,
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.cache_root = self.state_root / "cache" / "decision-prices"
        self.history_loader = history_loader or CachedDailyHistory(self.cache_root)
        self.fx_resolver = fx_resolver or HistoricalFxResolver(self.state_root / "raw" / "fx")

    def _account_day(self, context: StageContext, profile: str) -> pd.Timestamp:
        for artifact_id in reversed(context.upstream_artifact_ids):
            try:
                stored = self.artifacts.get_json(artifact_id)
            except (FileNotFoundError, RuntimeError):
                continue
            if stored.ref.key == f"account/{profile}.json":
                fetched = pd.Timestamp(str(stored.payload["fetched_at"]).replace("Z", "+00:00"))
                return fetched.tz_convert("UTC").tz_localize(None).normalize()
        return pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()

    def _review(self, context: StageContext, profile: str) -> dict[str, Any]:
        path = latest_export_path(profile, data_root=self.state_root / "trading212")
        if path is None:
            return {"status": "unavailable", "reason": "no managed Trading 212 export"}
        normalized = normalize_transactions_gbp(
            load_transactions([path]), fx_resolver=self.fx_resolver
        )
        trades = _trade_columns(normalized)
        campaigns, _ = reconstruct_campaigns(normalized)
        as_of = self._account_day(context, profile)
        memo_path = self.cache_root / f"listings-{profile}.json"
        memo: dict[str, str] = {}
        with suppress(FileNotFoundError, ValueError):
            memo = {str(k): str(v) for k, v in json.loads(memo_path.read_text("utf-8")).items()}
        prices, unpriced = resolve_decision_prices(
            trades, end_day=as_of, history_loader=self.history_loader, memo=memo
        )
        self.cache_root.mkdir(parents=True, exist_ok=True)
        memo_path.write_text(json.dumps(memo, sort_keys=True), encoding="utf-8")
        review = build_decision_review(
            trades, prices, campaigns=campaigns, unpriced=unpriced, as_of=as_of
        )
        return {"status": "available", **review}

    def run(self, context: StageContext) -> StageResult:
        accounts: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []
        for code, profile in selected_accounts(self.artifacts, context):
            try:
                accounts[code] = self._review(context, profile)
            except Exception as exc:
                accounts[code] = {
                    "status": "unavailable",
                    "reason": f"{type(exc).__name__}: {exc}"[:240],
                }
                warnings.append(f"{code}: decision review unavailable ({type(exc).__name__})")
        stored = self.artifacts.put_json(
            key=DECISIONS_KEY,
            payload={
                "schema_version": 1,
                "calculation_version": CALCULATION_VERSION,
                "accounts": accounts,
            },
            kind="account_decisions",
            producer_version=self.version,
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{sum(item['status'] == 'available' for item in accounts.values())}"
                f"/{len(accounts)} accounts",
                warnings=warnings,
            ),
        )
        return StageResult(artifacts=(stored.ref,), warnings=tuple(warnings))


__all__ = ["DECISIONS_KEY", "AccountDecisionStage"]
