"""Snapshot-bound context assembly for typed LLM synthesis."""

from __future__ import annotations

from typing import Any

from .artifacts import ArtifactStore
from .dashboard import build_dashboard_data
from .models import AnalysisLens, SnapshotManifest
from .research import ResearchLedger
from .watchlist import WatchlistStore

JsonObject = dict[str, Any]

PORTFOLIO_LENSES: tuple[AnalysisLens, ...] = (
    "daily_cio_brief",
    "hidden_exposure",
    "return_attribution",
    "watchlist_opportunity_map",
)
TICKER_LENSES: tuple[AnalysisLens, ...] = (
    "technical_regime",
    "valuation_scenario",
    "fundamental_health",
    "analyst_consensus",
    "financial_statements",
    "options_positioning",
    "thesis_change",
)


def _bounded_buckets(section: Any, limit: int = 12) -> Any:
    if not isinstance(section, dict):
        return section
    result = dict(section)
    if isinstance(result.get("buckets"), list):
        result["buckets"] = result["buckets"][:limit]
    for key in ("year", "month", "weekday"):
        if isinstance(result.get(key), list):
            result[key] = result[key][:limit]
    return result


def _compact_account_review(review: Any) -> Any:
    """Keep the model lens factual and bounded without losing warnings."""

    if not isinstance(review, dict):
        return review
    if "cash_flows" in review:  # CFD realised-only contract.
        attribution = review.get("attribution") or {}
        series = review.get("realised_series") or []
        trough = (
            min(series, key=lambda row: float(row.get("realised_pnl_drawdown") or 0.0))
            if series
            else None
        )
        return {
            "currency": review.get("currency"),
            "event_count": review.get("event_count"),
            "coverage_start": review.get("coverage_start"),
            "coverage_end": review.get("coverage_end"),
            "coverage": review.get("coverage"),
            "money_outcome": review.get("money_outcome"),
            "strategy_risk": review.get("strategy_risk"),
            "phases": {
                **(review.get("phases") or {}),
                "items": ((review.get("phases") or {}).get("items") or [])[:24],
            },
            "cash_flows": review.get("cash_flows"),
            "realised_pnl": review.get("realised_pnl"),
            "trade_quality": review.get("trade_quality"),
            "attribution": {
                key: value[:12] if isinstance(value, list) else value
                for key, value in attribution.items()
            },
            "notional": review.get("notional"),
            "structural_diagnostics": review.get("structural_diagnostics"),
            "ending_risk": review.get("ending_risk"),
            "realised_series_summary": {
                "point_count": len(series),
                "ending": series[-1] if series else None,
                "max_drawdown_point": trough,
            },
            "unmatched_executed_order_count": len(review.get("unmatched_executed_orders") or []),
            "warnings": review.get("warnings") or [],
            "calculation_version": review.get("calculation_version"),
            "import_status": review.get("import_status"),
        }

    result = {
        key: review.get(key)
        for key in (
            "schema_version",
            "calculation_version",
            "account",
            "coverage",
            "money_outcome",
            "strategy_risk",
            "structural_diagnostics",
            "warnings",
        )
    }
    phases = dict(review.get("phases") or {})
    phases["items"] = (phases.get("items") or [])[:24]
    result["phases"] = phases
    quality = dict(review.get("realised_trade_quality") or {})
    quality["best_trades"] = (quality.get("best_trades") or [])[:5]
    quality["worst_trades"] = (quality.get("worst_trades") or [])[:5]
    result["realised_trade_quality"] = quality
    attribution = dict(review.get("attribution") or {})
    for key in (
        "by_instrument",
        "by_industry",
        "by_country",
        "by_direction",
        "by_holding_bucket",
        "by_calendar",
    ):
        attribution[key] = _bounded_buckets(attribution.get(key))
    result["attribution"] = attribution
    ending = dict(review.get("ending_risk") or {})
    ending["holdings"] = (ending.get("holdings") or [])[:20]
    ending["exposures"] = {
        key: _bounded_buckets(value) for key, value in (ending.get("exposures") or {}).items()
    }
    result["ending_risk"] = ending
    return result


class AnalysisContextBuilder:
    """Build a bounded, evidence-only context from one immutable snapshot."""

    def __init__(self, store: ArtifactStore, watchlist: WatchlistStore) -> None:
        self.store = store
        self.watchlist = watchlist
        self.research = ResearchLedger(store, watchlist)

    def build(
        self,
        manifest: SnapshotManifest,
        lens: AnalysisLens,
        ticker: str | None,
    ) -> JsonObject:
        dashboard = build_dashboard_data(self.store, manifest)
        safe_accounts = []
        for account in dashboard.get("accounts", []):
            safe_account = dict(account)
            safe_account.pop("netExternalFlowsGbp", None)
            safe_account.pop("capitalDeltaGbp", None)
            safe_accounts.append(safe_account)
        compact_dashboard = {
            "brokerAsOf": dashboard.get("brokerAsOf"),
            "researchAsOf": dashboard.get("researchAsOf"),
            "totalValueGbp": dashboard.get("totalValueGbp"),
            "householdTotalValueGbp": dashboard.get("householdTotalValueGbp"),
            "totalCashGbp": dashboard.get("totalCashGbp"),
            "totalInvestedGbp": dashboard.get("totalInvestedGbp"),
            "latestModelDayReturn": dashboard.get("latestModelDayReturn"),
            "accounts": safe_accounts,
            "accountAnalysis": dashboard.get("accountAnalysis", {}),
            "historicalCfd": dashboard.get("cfd"),
            "holdings": dashboard.get("holdings", [])[:20],
            "risk": dashboard.get("risk"),
            "policy": dashboard.get("policy"),
            "lookthrough": {
                "coveragePct": dashboard.get("lookthrough", {}).get("lookthroughCoveragePct"),
                "countryAllocation": dashboard.get("lookthrough", {}).get("countryAllocation", [])[
                    :12
                ],
                "industryAllocation": dashboard.get("lookthrough", {}).get(
                    "industryAllocation", []
                )[:12],
                "positions": dashboard.get("lookthrough", {}).get("positions", [])[:20],
            },
        }
        payload: JsonObject = {
            "snapshotRunId": manifest.run_id,
            "snapshotCreatedAt": manifest.created_at.isoformat(),
            "lens": lens,
            "ticker": ticker,
            "dashboard": compact_dashboard,
            "sourceRefs": [artifact.key for artifact in manifest.artifacts],
        }
        if lens == "return_attribution" and ticker and ticker.upper() in {"A", "B", "C"}:
            account_code = ticker.upper()
            account_report = dashboard.get("accountReport") or {}
            payload["accountFocus"] = account_code
            payload["accountFocusMetrics"] = dashboard.get("accountAnalysis", {}).get(
                account_code, {}
            )
            payload["accountFocusHoldings"] = [
                holding
                for holding in dashboard.get("holdings", [])
                if holding.get("account") == account_code
            ]
            payload["accountFocusNav"] = account_report.get("nav", {}).get(account_code, {})
            payload["accountFocusDetail"] = account_report.get("analysis", {}).get(account_code, {})
            payload["accountFocusReview"] = _compact_account_review(
                dashboard.get("cfdReview")
                if account_code == "C"
                else dashboard.get("accountReviews", {}).get(account_code)
            )
            if account_code == "B":
                payload["accountFocusPolicy"] = account_report.get("policy", {})
            if account_code == "C":
                payload["accountFocusCfd"] = dashboard.get("cfd")
        if lens == "watchlist_opportunity_map":
            overview = self.research.overview(manifest, limit=100)
            try:
                raw_fundamentals = self.store.read_json(
                    manifest.run_id,
                    "research/fundamentals.json",
                )
            except FileNotFoundError:
                raw_fundamentals = {}
            fundamental_rows = raw_fundamentals.get("rows")
            if not isinstance(fundamental_rows, list):
                fundamental_rows = raw_fundamentals.get("fundamentals")
            profiles: dict[str, dict[str, Any]] = {}
            if isinstance(fundamental_rows, list):
                for row in fundamental_rows:
                    if not isinstance(row, dict):
                        continue
                    row_ticker = str(row.get("ticker") or "").upper()
                    metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
                    if not row_ticker:
                        continue
                    profiles[row_ticker] = {
                        "sector": str(row.get("sector") or "")[:120],
                        "industry": str(row.get("industry") or "")[:160],
                        "businessSummary": str(metrics.get("longBusinessSummary") or "")[:2_000],
                        "website": str(metrics.get("website") or "")[:300],
                        "securityType": str(metrics.get("quoteType") or "")[:80],
                        "source": str(row.get("source") or "")[:80],
                    }
            payload["taxonomyCategories"] = [
                category.model_dump(mode="json", by_alias=True)
                for category in self.watchlist.categories()
                if category.id != "new-ideas"
            ]
            payload["instruments"] = [
                {
                    "ticker": item.ticker,
                    "name": item.name,
                    "categoryId": item.category_id,
                    "status": item.status,
                    "held": item.held,
                    "exposureGbp": item.exposure_gbp,
                    "gics": (
                        item.gics.model_dump(mode="json", by_alias=True) if item.gics else None
                    ),
                    "profile": profiles.get(item.ticker, {}),
                    "coverage": {
                        "market": item.has_market,
                        "technical": item.has_technical,
                        "options": item.has_options,
                        "valuation": item.has_valuation,
                        "earnings": item.has_earnings,
                    },
                }
                for item in overview.instruments
            ]
        if lens in TICKER_LENSES:
            if not ticker:
                raise ValueError(f"ticker is required for {lens} analysis")
            selected = self.research.ticker_snapshot(ticker, manifest)
            payload["selected"] = selected.model_dump(mode="json", by_alias=True)
            payload["events"] = [
                item.model_dump(mode="json", by_alias=True)
                for item in self.research.events(ticker, manifest)
            ]
            payload["alerts"] = [
                item.model_dump(mode="json", by_alias=True)
                for item in self.research.alerts(ticker, manifest)
            ]
            payload["timeline"] = [
                item.model_dump(mode="json", by_alias=True)
                for item in self.research.timeline(ticker, limit=8)
            ]
        return payload


__all__ = ["PORTFOLIO_LENSES", "TICKER_LENSES", "AnalysisContextBuilder", "JsonObject"]
