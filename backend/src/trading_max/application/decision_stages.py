"""Publish per-account decision reviews: each buy and sell against what followed."""

from __future__ import annotations

import json
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from trading_max.analytics.decision_events import (
    CachedSecurityEvents,
    EventLoader,
    attach_decision_events,
)
from trading_max.analytics.decision_prices import (
    CachedDailyHistory,
    SecurityPrices,
    final_rate_on,
    final_rates,
    resolve_decision_prices,
    session_closes,
)
from trading_max.analytics.decision_review import (
    BENCHMARK_CALENDAR,
    CALCULATION_VERSION,
    build_decision_review,
)
from trading_max.analytics.fx import FxResolver, HistoricalFxResolver
from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    HistoryLoader,
    _current_position_map,
    _supplemental_cash_events,
    _trade_columns,
    ledger_events,
)
from trading_max.analytics.ledger import (
    load_transactions,
    normalize_transactions_gbp,
    reconstruct_campaigns,
)
from trading_max.analytics.review_evidence import (
    AccountReviewEvidence,
    InvestmentReviewEvidence,
    ReviewListing,
    ReviewRules,
    build_review_evidence,
)
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.ingestion.brokers.trading212 import (
    latest_cash_transactions_path,
    latest_export_path,
)
from trading_max.research.calendar import completed_daily_bars

from .account_selection import selected_accounts
from .stages import StageContext, StageResult

DECISIONS_KEY = "account/decisions.json"
REVIEW_EVIDENCE_KEY = "account/review_evidence.json"
#: The benchmark that separates the market's move from a security's own, in GBP;
#: it trades on the BENCHMARK_CALENDAR exchange's sessions.
BENCHMARK_SYMBOL = "SPY"


class AccountDecisionStage:
    """Publish decision outcomes and reconciled allocation evidence."""

    name = "accounts.decisions"
    version = "decision-review-stage-v6"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        *,
        history_loader: HistoryLoader | None = None,
        fx_resolver: FxResolver | None = None,
        events_loader: EventLoader | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.cache_root = self.state_root / "cache" / "decision-prices"
        self.now = now
        self.history_loader = history_loader or CachedDailyHistory(self.cache_root, now=now)
        self.fx_resolver = fx_resolver or HistoricalFxResolver(self.state_root / "raw" / "fx")
        self.events_loader = events_loader or CachedSecurityEvents(
            self.state_root / "cache" / "decision-events"
        )

    def _market(
        self, start: pd.Timestamp, end: pd.Timestamp, now: pd.Timestamp
    ) -> pd.Series | None:
        """Benchmark closes in GBP on its sessions; the review stays usable without them.

        A session still pending, without its close or its rate, is left out, and
        the review withholds the windows that need it; one older than
        GAP_SESSIONS sessions takes the close before it, like a listing's.
        """

        try:
            frame = completed_daily_bars(
                self.history_loader(BENCHMARK_SYMBOL, start.date(), end.date()), now=now
            )
            usd = final_rates(self.history_loader, "GBPUSD=X", start, end, now)
        except Exception:
            return None
        closes = pd.to_numeric(frame.get("Close"), errors="coerce").dropna()
        if closes.empty or usd.empty:
            return None
        closes.index = pd.to_datetime(closes.index).tz_localize(None).normalize()
        rates = final_rate_on(usd, pd.date_range(start, end, freq="D"), now)
        market = session_closes(closes, rates, BENCHMARK_CALENDAR, start=start, end=end, now=now)
        return market.dropna()

    def _account(self, context: StageContext, profile: str) -> dict[str, Any] | None:
        for artifact_id in reversed(context.upstream_artifact_ids):
            with suppress(FileNotFoundError, RuntimeError):
                if self.artifacts.get_ref(artifact_id).key == f"account/{profile}.json":
                    return self.artifacts.get_json(artifact_id).payload
        return None

    def _evidence(
        self,
        profile: str,
        account: dict[str, Any] | None,
        trades: pd.DataFrame,
        prices: dict[str, SecurityPrices],
        fx_frames: dict[str, pd.DataFrame],
    ) -> AccountReviewEvidence:
        if account is None:
            return AccountReviewEvidence(coverage="partial")
        as_of = pd.Timestamp(account["fetched_at"])
        positions = _current_position_map(account["positions"])
        currencies = (
            trades.loc[trades["TradeCurrency"].ne("")]
            .groupby("SecurityIdentity")["TradeCurrency"]
            .last()
        )
        listings = {}
        for identity, price in prices.items():
            currency = str(
                positions.get(identity, {}).get("price_currency") or currencies.get(identity, "")
            )
            if currency and price.listing_currency and price.market_frame is not None:
                listings[identity] = ReviewListing(
                    price.ticker, currency, price.symbol, price.listing_currency, price.market_frame
                )
        supplemental = _supplemental_cash_events(
            latest_cash_transactions_path(profile, data_root=self.state_root / "trading212"), trades
        )
        return build_review_evidence(
            ledger_events(trades, supplemental),
            listings,
            fx_frames,
            as_of=as_of,
            terminal_holdings={key: float(row["quantity"]) for key, row in positions.items()},
            terminal_cash_gbp=float(account["cash_gbp"]),
            terminal_value_gbp=float(account["total_value_gbp"]),
        )

    def _review(
        self, context: StageContext, profile: str
    ) -> tuple[dict[str, Any], AccountReviewEvidence]:
        partial = AccountReviewEvidence(coverage="partial")
        path = latest_export_path(profile, data_root=self.state_root / "trading212")
        if path is None:
            return {"status": "unavailable", "reason": "no managed Trading 212 export"}, partial
        transactions = load_transactions([path])
        normalized = normalize_transactions_gbp(transactions, fx_resolver=self.fx_resolver)
        trades = _trade_columns(normalized)
        campaigns, _ = reconstruct_campaigns(normalized)
        account = self._account(context, profile)
        now = pd.Timestamp(self.now())
        as_of = pd.Timestamp(account["fetched_at"]) if account is not None else now
        end_day = as_of.tz_convert("UTC").tz_localize(None).normalize()
        memo_path = self.cache_root / f"listings-{profile}.json"
        memo: dict[str, str] = {}
        with suppress(FileNotFoundError, ValueError):
            memo = {str(k): str(v) for k, v in json.loads(memo_path.read_text("utf-8")).items()}

        fx_frames: dict[str, pd.DataFrame] = {}

        def capture_fx(loader: HistoryLoader) -> HistoryLoader:
            def read(symbol: str, start: date, end: date) -> pd.DataFrame:
                frame = loader(symbol, start, end)
                if symbol.startswith("GBP") and symbol.endswith("=X"):
                    code = symbol[3:-2]
                    if code not in fx_frames or len(frame) > len(fx_frames[code]):
                        fx_frames[code] = frame
                return frame

            return read

        try:
            prices, unpriced = resolve_decision_prices(
                trades,
                end_day=end_day,
                history_loader=capture_fx(self.history_loader),
                memo=memo,
                now=now,
            )
        except HistoricalNavError as exc:
            # The decision benchmark needs a dollar cross. An unrelated
            # sterling allocation can still be measured, using only cache.
            partial.as_of = as_of.to_pydatetime()
            with suppress(OSError, ValueError, KeyError, TypeError, ArithmeticError):
                cached = CachedDailyHistory(self.cache_root)
                prices, _ = resolve_decision_prices(
                    trades,
                    end_day=end_day,
                    history_loader=capture_fx(cached.read_cached),
                    memo=memo,
                    now=now,
                    allow_missing_usd=True,
                )
                partial = self._evidence(profile, account, trades, prices, fx_frames)
            return {"status": "unavailable", "reason": f"{type(exc).__name__}: {exc}"}, partial
        self.cache_root.mkdir(parents=True, exist_ok=True)
        memo_path.write_text(json.dumps(memo, sort_keys=True), encoding="utf-8")
        try:
            evidence = self._evidence(profile, account, trades, prices, fx_frames)
        except (OSError, ValueError, KeyError, TypeError, ArithmeticError):
            # Evidence is optional; a missing/malformed sidecar or mark must
            # never take down the existing decision journal.
            evidence = AccountReviewEvidence(as_of=as_of.to_pydatetime(), coverage="partial")
        start = pd.Timestamp(trades["BusinessDate"].min()) - pd.Timedelta(days=14)
        review = build_decision_review(
            trades,
            prices,
            campaigns=campaigns,
            unpriced=unpriced,
            as_of=end_day,
            market=self._market(start, end_day, now),
            benchmark_calendar=BENCHMARK_CALENDAR,
        )
        attach_decision_events(
            review,
            {security.ticker: security for security in prices.values()},
            self.events_loader,
        )
        return {"status": "available", **review}, evidence

    def run(self, context: StageContext) -> StageResult:
        accounts: dict[str, dict[str, Any]] = {}
        evidence = InvestmentReviewEvidence(rules=ReviewRules.current(), accounts={})
        warnings: list[str] = []
        for code, profile in selected_accounts(self.artifacts, context):
            try:
                accounts[code], evidence.accounts[code] = self._review(context, profile)
                if accounts[code]["status"] == "unavailable" and accounts[code][
                    "reason"
                ].startswith("HistoricalNavError:"):
                    warnings.append(f"{code}: decision review unavailable (HistoricalNavError)")
            except Exception as exc:
                accounts[code] = {
                    "status": "unavailable",
                    "reason": f"{type(exc).__name__}: {exc}"[:240],
                }
                evidence.accounts[code] = AccountReviewEvidence(coverage="partial")
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
        observations = self.artifacts.put_json(
            key=REVIEW_EVIDENCE_KEY,
            payload=evidence.model_dump(mode="json"),
            kind="account_review_evidence",
            producer_version=self.version,
            dependency_artifact_ids=list(context.upstream_artifact_ids),
            quality=ArtifactQuality(
                status="warning"
                if any(v.coverage == "partial" for v in evidence.accounts.values())
                else "verified",
                coverage=f"{sum(v.coverage == 'complete' for v in evidence.accounts.values())}/{len(evidence.accounts)} accounts",
            ),
        )
        return StageResult(artifacts=(stored.ref, observations.ref), warnings=tuple(warnings))


__all__ = ["DECISIONS_KEY", "AccountDecisionStage"]
