"""Durable worker stages for typed market research."""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime

from trading_max.analytics.cash_flow_history import AccountCashFlowHistory
from trading_max.analytics.day_attribution import (
    DayAttribution,
    DayBaseline,
    WindowAttribution,
    WindowBaselines,
    update_day_attribution,
    update_window_attribution,
    window_days,
)
from trading_max.analytics.etf_journal import (
    ETF_BENCHMARKS_KEY,
    ETF_JOURNAL_KEY,
    BenchmarkObservation,
    update_etf_journal,
)
from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY, ETFPortfolio
from trading_max.analytics.exposure_history import record_exposure
from trading_max.analytics.intraday import IntradayAnchorSeries, merge_valuation_history
from trading_max.domain import ArtifactQuality, ArtifactRef
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
    StoredSnapshot,
)
from trading_max.reference import CatalogSecurityMaster, SecurityMasterCatalog, is_fund_instrument
from trading_max.research.coverage import merge_rows, row_clocks
from trading_max.research.earnings_changes import bind_estimate_changes
from trading_max.research.estimate_history import (
    ANALYST_KEY,
    ESTIMATE_KEYS,
    FUNDAMENTALS_KEY,
    SCHEDULED_RESEARCH_TRIGGERS,
    EstimateHistory,
    estimate_observations,
)
from trading_max.research.fund_references import fund_peers, us_fund, us_fund_listing
from trading_max.research.fundamentals import (
    AnalystBatch,
    EarningsBatch,
    FinancialsBatch,
    ResearchDataError,
    ValuationBatch,
    YFinanceResearchService,
    build_valuation,
)
from trading_max.research.held_funds import (
    BROKER_SNAPSHOT_KEY,
    FUND_PRICE_DIRECTORY_KEY,
    FUND_PRICES_KEY,
    LOOKTHROUGH_KEY,
    SECURITY_MASTER_KEY,
    FundListingIdentity,
    held_fund_positions,
    known_fund,
)
from trading_max.research.market import (
    MarketResearchService,
    OptionsResearchBatch,
    TechnicalResearchBatch,
)

from .account_selection import ACCOUNT_PROFILES
from .broker_stages import broker_snapshot_key
from .errors import StageExecutionError
from .nav_stages import (
    DAY_ATTRIBUTION_KEY,
    DAY_BASELINE_KEY,
    VALUATION_HISTORY_KEY,
    WINDOW_ATTRIBUTION_KEY,
    WINDOW_BASELINES_KEY,
    load_share_movements,
)
from .stages import StageContext, StageResult

LOGGER = logging.getLogger(__name__)


def _upstream_json(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    key: str,
):
    for artifact_id in context.upstream_artifact_ids:
        try:
            ref = artifacts.get_ref(artifact_id)
            if ref.key != key or ref.media_type != "application/json":
                continue
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == key:
            return stored
    return None


def _quality_status(warnings: list[str]) -> str:
    return "warning" if warnings else "verified"


MERGEABLE_RESEARCH_KEYS = frozenset(
    {
        "research/market_snapshot.json",
        FUND_PRICE_DIRECTORY_KEY,
        FUND_PRICES_KEY,
        "research/technical.json",
        "research/options.json",
        "research/adr.json",
        "research/fundamentals.json",
        "research/valuation.json",
        "research/earnings.json",
        "research/analyst.json",
        "research/financials.json",
    }
)


def merge_partial_rows(
    previous: dict | None,
    payload: dict,
    *,
    refreshed: tuple[str, ...],
) -> dict:
    """Carry forward rows for tickers a partial research job did not refresh.

    Research artifacts are whole-file replacements keyed by artifact key, so a
    single-ticker refresh would otherwise publish a snapshot containing only
    that ticker and silently drop every other watchlist row. A partial job must
    only ever replace the tickers it actually recomputed.
    """

    if previous is None or not refreshed:
        return payload
    return merge_rows(previous, payload, refreshed)


def _retain_benchmarks(previous: dict, current: dict) -> dict:
    """A failed benchmark request cannot erase the prior benchmark history."""
    if "benchmark_series" not in current:
        return current
    return {
        **current,
        "benchmark_series": {
            **previous.get("benchmark_series", {}),
            **{key: points for key, points in current["benchmark_series"].items() if points},
        },
    }


def merge_partial_market_snapshot(
    previous: dict | None,
    payload: dict,
    *,
    refreshed: tuple[str, ...],
) -> dict:
    """Merge the nested technical/options rows of a partial market snapshot."""

    if previous is None:
        return payload
    merged = dict(payload)
    for section in ("technical", "options"):
        previous_section = previous.get(section)
        current_section = payload.get(section)
        if not isinstance(previous_section, dict) or not isinstance(current_section, dict):
            continue
        if section == "options":
            attempted = tuple(current_section.get("tickers") or ())
        else:
            attempted = refreshed
        merged_section = (
            merge_partial_rows(previous_section, current_section, refreshed=attempted)
            if attempted
            else previous_section
        )
        if section == "technical":
            merged_section = _retain_benchmarks(previous_section, merged_section)
        if merged_section is not current_section:
            merged[section] = merged_section
    previous_tickers = previous.get("tickers")
    current_tickers = payload.get("tickers")
    if isinstance(previous_tickers, list) and isinstance(current_tickers, list):
        merged["tickers"] = list(dict.fromkeys([*previous_tickers, *current_tickers]))
    return merged


def _fund_inputs(artifacts, snapshots, context):
    latest = snapshots.latest(verify_artifacts=False) if snapshots is not None else None
    prior = {ref.key: ref for ref in latest.manifest.artifacts} if latest else {}

    def read(key):
        current = _upstream_json(artifacts, context, key)
        if current is not None:
            return current.payload
        if key in prior:
            return artifacts.get_json(prior[key].artifact_id).payload
        return {}

    raw_catalog = read(SECURITY_MASTER_KEY)
    catalog = (
        CatalogSecurityMaster(SecurityMasterCatalog.model_validate(raw_catalog))
        if raw_catalog or snapshots is None
        else CatalogSecurityMaster.from_state_root(snapshots.root)
    )
    funds = held_fund_positions(
        read(BROKER_SNAPSHOT_KEY),
        read(LOOKTHROUGH_KEY),
        ETFPortfolio.model_validate(read(ETF_SUMMARY_KEY)).funds,
        catalog,
    )
    return catalog, funds


def _equity_tickers(artifacts, context):
    market = _upstream_json(artifacts, context, "research/market_snapshot.json")
    if market is not None and "equity_tickers" in market.payload:
        return tuple(market.payload["equity_tickers"])
    return context.tickers


def _fund_listings(
    catalog: CatalogSecurityMaster,
    holdings: dict[FundListingIdentity, dict[str, dict]],
    context: StageContext,
) -> dict[str, list[FundListingIdentity]]:
    requested = {ticker.strip().upper() for ticker in context.tickers}
    all_funds = context.scope == "all" or context.trigger in SCHEDULED_RESEARCH_TRIGGERS
    listings: dict[str, list[FundListingIdentity]] = {}
    for listing in holdings:
        if (
            all_funds
            or listing.ticker in requested
            or (listing.symbol in requested and not us_fund(listing.symbol))
        ):
            listings.setdefault(listing.ticker, []).append(listing)
    # Only use the broker-qualified listing for a held fund, or an exact
    # catalog symbol for a separately saved fund.
    for ticker in requested - listings.keys():
        if us_fund(ticker) or (
            not any(ticker == item.symbol for item in holdings) and known_fund(catalog, ticker)
        ):
            listings[ticker] = []
    return listings


class FundPriceStage:
    """Project listing prices from the same completed bars as technical research."""

    name = "research.fund_prices"
    version = "fund-prices-v5"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(self, artifacts: ContentAddressedArtifactStore):
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(self.artifacts, context, "research/market_snapshot.json")
        listings = source.payload.get("fund_listings") if source else None
        if not listings:
            return StageResult()
        batch = source.payload["technical"]
        rows = []
        for row in batch["rows"]:
            ticker = row["ticker"]
            if ticker not in listings:
                continue
            as_of, series = row["as_of"], row["price_series"]
            rows.append(
                {
                    "ticker": ticker,
                    **listings[ticker],
                    "as_of": as_of,
                    "spot": row["price"],
                    "asset_type": row.get("asset_type") or None,
                    **(
                        {"provider_venue": row["provider_venue"]}
                        if row.get("provider_venue")
                        else {}
                    ),
                    **(
                        {"market_segment": row["market_segment"]}
                        if row.get("market_segment")
                        else {}
                    ),
                    "currency": row["currency"],
                    "exchange": row["exchange"],
                    "timezone": row["timezone"],
                    "price_series": series,
                    "previous_close": series[-2]["close"]
                    if len(series) >= 2 and series[-1]["date"] == as_of
                    else None,
                }
            )
        warnings = [
            f"{ticker}: fund price history unavailable"
            for ticker in sorted(listings.keys() - {row["ticker"] for row in rows})
        ]
        ref = self.artifacts.put_json(
            key=FUND_PRICES_KEY,
            payload={
                "tickers": sorted(listings),
                "rows": rows,
                "generated_at": datetime.now(UTC).isoformat(),
            },
            kind="fund-prices",
            as_of=max((row["as_of"] for row in rows), default=None),
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(status=_quality_status(warnings), warnings=warnings),
        ).ref
        directory = self.artifacts.put_json(
            key=FUND_PRICE_DIRECTORY_KEY,
            payload={
                "tickers": sorted(listings),
                "rows": [
                    {key: value for key, value in row.items() if key != "price_series"}
                    for row in rows
                ],
            },
            kind="fund-price-directory",
            as_of=ref.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[ref.artifact_id],
        ).ref
        return StageResult(artifacts=(ref, directory), warnings=tuple(warnings))


class MarketSnapshotStage:
    """Fetch the watchlist once and publish a reusable market input artifact."""

    name = "market.snapshot"
    version = "market-snapshot-v14"
    required_for = frozenset({"all", "research"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: MarketResearchService | None = None,
        snapshots: SnapshotStore | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.service = service or MarketResearchService()
        self.snapshots = snapshots

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "market snapshot requires a non-empty watchlist",
            )
        catalog, funds = _fund_inputs(self.artifacts, self.snapshots, context)
        requested = tuple(dict.fromkeys(value.strip().upper() for value in context.tickers))
        fund_symbols = {item.ticker for item in funds}
        listings = _fund_listings(catalog, funds, context)
        fund_tickers = tuple(
            sorted(ticker for ticker, identities in listings.items() if len(identities) <= 1)
        )
        fund_warnings = [
            f"{ticker}: ambiguous fund listing"
            for ticker in sorted(listings.keys() - set(fund_tickers))
        ]
        # Respect a qualified US reference even when the same letters appear
        # on a broker-held London listing (for example SMH and SMH.L).
        held_symbols = fund_symbols | {item.symbol for item in funds if not us_fund(item.symbol)}
        equities = tuple(
            ticker
            for ticker in requested
            if ticker not in held_symbols
            and not us_fund(ticker)
            and not known_fund(catalog, ticker)
        )
        etf_options = {ticker for ticker in requested if us_fund(ticker)}
        for ticker in fund_tickers:
            identities = listings[ticker]
            if identities:
                listing = identities[0]
                etf_options.update(peer.fund.ticker for peer in fund_peers(listing.isin))
                if us_fund_listing(listing):
                    etf_options.add(ticker)
        # Watchlisted US ETFs can have their own chains even before a direct position exists.
        etf_options.update(
            ticker
            for ticker in requested
            if ticker not in held_symbols
            and "." not in ticker
            and any(
                record.security_type == "ETF"
                and any(
                    listing.ticker == ticker and us_fund_listing(listing)
                    for listing in record.listings
                )
                for record in catalog.catalog.records
            )
        )
        try:
            if fund_tickers:
                technical, options = self.service.run(
                    (*equities, *fund_tickers), fund_tickers=fund_tickers
                )
            elif equities:
                technical, options = self.service.run(equities)
            else:
                now = datetime.now(UTC)
                empty = {
                    "as_of": now.date().isoformat(),
                    "generated_at": now,
                    "tickers": [],
                    "rows": [],
                }
                technical, options = TechnicalResearchBatch(**empty), OptionsResearchBatch(**empty)
        except Exception as exc:
            raise StageExecutionError(
                "market.snapshot_failed",
                str(exc),
                retryable=True,
            ) from exc
        # Also recognize funds identified by the price provider on a first refresh.
        discovered = {
            row.ticker
            for row in technical.rows
            if row.asset_type == "MUTUALFUND" or is_fund_instrument(quote_type=row.asset_type)
        }
        equities = tuple(ticker for ticker in equities if ticker not in discovered)
        technical.warnings.extend(fund_warnings)
        # One scheduled chain capture per day, plus a deliberately requested
        # refresh. Other research slots retain the last successful ETF rows.
        if etf_options and context.trigger != "research":
            self.service.extend_fund_options(options, etf_options)
        warnings = list(dict.fromkeys(technical.warnings + options.warnings))
        payload = {
            "schema_version": 1,
            "artifact_type": "market_snapshot_input",
            "as_of": technical.as_of,
            "generated_at": technical.generated_at.isoformat(),
            "tickers": technical.tickers,
            "equity_tickers": list(equities),
            "fund_listings": {
                ticker: (
                    {"isin": identities[0].isin, "mic": identities[0].mic}
                    if (identities := listings.get(ticker))
                    else {"isin": "", "mic": ""}
                )
                for ticker in sorted(set(fund_tickers) | discovered)
            },
            "technical": technical.model_dump(mode="json", by_alias=False),
            "options": options.model_dump(mode="json", by_alias=False),
        }
        artifact = self.artifacts.put_json(
            key="research/market_snapshot.json",
            payload=payload,
            kind="market",
            as_of=technical.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(warnings),
                coverage=f"{len(technical.rows)}/{len(technical.tickers)}",
                warnings=warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(warnings),
            metadata={"as_of": technical.as_of},
        )


class TechnicalResearchStage:
    """Publish technical and options batches from one typed provider call."""

    name = "research.technical"
    version = "technical-v4"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: MarketResearchService | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.service = service or MarketResearchService()

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "technical research requires a non-empty watchlist",
            )
        try:
            technical, options = self.service.run(context.tickers)
        except Exception as exc:
            if isinstance(exc, StageExecutionError):
                raise
            raise StageExecutionError(
                "research.technical_failed",
                str(exc),
                retryable=True,
            ) from exc

        quality_status = "warning" if technical.warnings else "verified"
        technical_artifact = self.artifacts.put_json(
            key="research/technical.json",
            payload=technical.model_dump(mode="json", by_alias=False),
            kind="technical",
            as_of=technical.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=quality_status,
                coverage=f"{len(technical.rows)}/{len(technical.tickers)}",
                warnings=technical.warnings,
            ),
        )
        options_artifact = self.artifacts.put_json(
            key="research/options.json",
            payload=options.model_dump(mode="json", by_alias=False),
            kind="options",
            as_of=options.as_of,
            producer_version="options-v2",
            dependency_artifact_ids=[technical_artifact.ref.artifact_id],
            quality=ArtifactQuality(
                status="warning" if options.warnings else "verified",
                coverage=f"{len(options.rows)}/{len(options.tickers)}",
                warnings=options.warnings,
            ),
        )
        return StageResult(
            artifacts=(technical_artifact.ref, options_artifact.ref),
            warnings=tuple(technical.warnings),
            metadata={"as_of": technical.as_of},
        )


class TechnicalArtifactStage:
    """Project technical rows from the immutable market input."""

    name = "research.technical"
    version = "technical-v10"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.market_dependency_missing",
                "technical research requires the current market snapshot",
            )
        try:
            batch = TechnicalResearchBatch.model_validate(source.payload["technical"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.technical_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/technical.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="technical",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class OptionsArtifactStage:
    """Project options positioning from the same market input as technical."""

    name = "research.options"
    version = "options-v6"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.market_dependency_missing",
                "options research requires the current market snapshot",
            )
        try:
            batch = OptionsResearchBatch.model_validate(source.payload["options"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.options_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/options.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="options",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(artifacts=(artifact.ref,), warnings=tuple(batch.warnings))


class AdrArtifactStage:
    """Publish ADR parity research without splicing home-market prices."""

    name = "research.adr"
    version = "adr-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/technical.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.technical_dependency_missing",
                "ADR research requires technical research",
            )
        rows = [
            {
                "ticker": row["ticker"],
                "adr_research": row["adr_research"],
            }
            for row in source.payload.get("rows", [])
            if isinstance(row, dict) and row.get("adr_research")
        ]
        payload = {
            "schema_version": 1,
            "artifact_type": "adr_research_batch",
            "as_of": source.payload.get("as_of"),
            "generated_at": source.payload.get("generated_at"),
            "tickers": [row["ticker"] for row in rows],
            "rows": rows,
            "warnings": [],
        }
        artifact = self.artifacts.put_json(
            key="research/adr.json",
            payload=payload,
            kind="adr",
            as_of=str(source.payload.get("as_of") or "") or None,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(rows)}/{len(context.tickers)} ADRs",
            ),
        )
        return StageResult(artifacts=(artifact.ref,))


class FundamentalsArtifactStage:
    """Fetch and normalize fundamentals for the current watchlist."""

    name = "research.fundamentals"
    version = "fundamentals-v8"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "fundamentals research requires a non-empty watchlist",
            )
        market = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        as_of = str(market.payload.get("as_of")) if market else None
        tickers = _equity_tickers(self.artifacts, context)
        if not tickers:
            return StageResult()
        try:
            batch = self.service.fundamentals(tickers, as_of=as_of)
        except ResearchDataError as exc:
            raise StageExecutionError(
                "research.fundamentals_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/fundamentals.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="fundamentals",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class FinancialsArtifactStage:
    """Fetch annual and quarterly financial statements."""

    name = "research.financials"
    version = "financials-v4"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "financials research requires a non-empty watchlist",
            )
        tickers = _equity_tickers(self.artifacts, context)
        if not tickers:
            return StageResult()
        try:
            batch = self.service.financials(tickers)
            FinancialsBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.financials_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/financials.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="financials",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class AnalystArtifactStage:
    """Fetch analyst consensus estimates, ratings and target prices."""

    name = "research.analyst"
    version = "analyst-v4"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "analyst research requires a non-empty watchlist",
            )
        tickers = _equity_tickers(self.artifacts, context)
        if not tickers:
            return StageResult()
        try:
            batch = self.service.analyst(tickers)
            AnalystBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.analyst_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/analyst.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="analyst",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class ValuationArtifactStage:
    """Calculate evidence-gated scenario valuation lenses.

    Versioned assumptions override sector defaults when present. Provider free
    cash flow is handled as a levered proxy paired with cost of equity; analyst
    targets remain an independent reference rather than a numeric fallback.
    """

    name = "research.valuation"
    version = "valuation-v7"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical", "research.fundamentals", "research.financials")

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore | None = None,
        *,
        fx_loader=None,
        assumptions_store=None,
        state_root=None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.fx_loader = fx_loader
        self.assumptions_store = assumptions_store
        self.state_root = state_root

    def _previous_assumptions(self) -> dict | None:
        store = self.assumptions_store
        if store is not None:
            try:
                payload = store.to_snapshot_payload()
                if payload.get("companies"):
                    return payload
            except Exception:
                return None
        if self.snapshots is None:
            return None
        previous = self.snapshots.latest()
        if previous is None:
            return None
        ref = next(
            (
                item
                for item in previous.manifest.artifacts
                if item.key == "research/valuation_assumptions.json"
            ),
            None,
        )
        if ref is None:
            return None
        try:
            return self.artifacts.get_json(ref.artifact_id).payload
        except (FileNotFoundError, KeyError, ValueError):
            return None

    def run(self, context: StageContext) -> StageResult:
        equities = _equity_tickers(self.artifacts, context)
        if context.tickers and not equities:
            return StageResult()
        technical = _upstream_json(
            self.artifacts,
            context,
            "research/technical.json",
        )
        fundamentals = _upstream_json(
            self.artifacts,
            context,
            "research/fundamentals.json",
        )
        if technical is None or fundamentals is None:
            raise StageExecutionError(
                "research.valuation_dependency_missing",
                "valuation requires current technical and fundamentals artifacts",
            )
        try:
            financials = _upstream_json(self.artifacts, context, "research/financials.json")
            catalog = _upstream_json(self.artifacts, context, SECURITY_MASTER_KEY)
            if catalog is None and self.snapshots:
                previous = self.snapshots.latest(verify_artifacts=False)
                ref = (
                    next(
                        (
                            ref
                            for ref in previous.manifest.artifacts
                            if ref.key == SECURITY_MASTER_KEY
                        ),
                        None,
                    )
                    if previous
                    else None
                )
                if ref:
                    catalog = self.artifacts.get_json(ref.artifact_id)
            master = (
                CatalogSecurityMaster(SecurityMasterCatalog.model_validate(catalog.payload))
                if catalog
                else CatalogSecurityMaster.from_state_root(self.state_root)
                if self.state_root
                else None
            )
            batch = build_valuation(
                {**technical.payload, "tickers": list(equities)},
                fundamentals.payload,
                security_master=master,
                assumptions=self._previous_assumptions(),
                fx_loader=self.fx_loader,
                financials=financials.payload if financials else {},
            )
            ValuationBatch.model_validate(batch.model_dump(mode="json"))
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.valuation_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/valuation.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="valuation",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[
                technical.ref.artifact_id,
                fundamentals.ref.artifact_id,
                *([financials.ref.artifact_id] if financials else []),
                *([catalog.ref.artifact_id] if catalog else []),
            ],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        artifacts = [artifact.ref]
        store = self.assumptions_store
        if store is not None:
            assumptions_payload = store.to_snapshot_payload()
            assumptions_artifact = self.artifacts.put_json(
                key="research/valuation_assumptions.json",
                payload=assumptions_payload,
                kind="assumptions",
                as_of=str(assumptions_payload.get("as_of") or "") or None,
                producer_version="valuation-assumptions-v2",
            )
            artifacts.append(assumptions_artifact.ref)
        return StageResult(
            artifacts=tuple(artifacts),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class EarningsArtifactStage:
    """Publish earnings calendar data with explicit source quality."""

    name = "research.earnings"
    version = "earnings-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "earnings research requires a non-empty watchlist",
            )
        tickers = _equity_tickers(self.artifacts, context)
        if not tickers:
            return StageResult()
        try:
            batch = self.service.earnings(tickers)
            EarningsBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.earnings_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/earnings.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="earnings",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


CASH_FLOW_KEYS = frozenset({"account/nav/cash_flows_a.json", "account/nav/cash_flows_b.json"})


def _merge_day_baseline(previous: DayBaseline, incoming: DayBaseline) -> DayBaseline:
    if incoming.day < previous.day:
        return previous
    if incoming.day > previous.day:
        return incoming
    accounts = dict(previous.accounts)
    for code, opening in incoming.accounts.items():
        existing = accounts.get(code)
        if existing is None or opening.captured_at < existing.captured_at:
            accounts[code] = opening
    return DayBaseline(day=incoming.day, accounts=accounts)


def _merge_window_baselines(
    previous: WindowBaselines, incoming: WindowBaselines
) -> WindowBaselines:
    prev_max = max((item.day for item in previous.days), default=None)
    inc_max = max((item.day for item in incoming.days), default=None)
    if prev_max is not None and (inc_max is None or inc_max < prev_max):
        return previous
    if inc_max is None or prev_max is None:
        return incoming
    prev_by_day = {item.day: item for item in previous.days}
    inc_by_day = {item.day: item for item in incoming.days}
    days: list[DayBaseline] = []
    for day in window_days(inc_max):
        prev_day, inc_day = prev_by_day.get(day), inc_by_day.get(day)
        if prev_day is not None and inc_day is not None:
            days.append(_merge_day_baseline(prev_day, inc_day))
        elif prev_day is not None:
            days.append(prev_day)
        elif inc_day is not None:
            days.append(inc_day)
    return WindowBaselines(days=days)


class TypedPublishSnapshotStage:
    """Publish the exact artifact IDs produced by preceding typed stages."""

    name = "snapshot.publish"
    version = "snapshot-v2"
    required_for = frozenset({"all", "accounts", "research", "intraday", "cfd"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        on_snapshot_published: Callable[[StoredSnapshot, str], None] | None = None,
        *,
        estimate_history: EstimateHistory | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.on_snapshot_published = on_snapshot_published
        self.estimate_history = estimate_history

    def publication_visible(self, run_id: str) -> bool:
        return self.snapshots.was_published(run_id)

    def find_publication(self, job_id: str, trigger: str) -> str | None:
        return self.snapshots.find_publication(f"{trigger}:{job_id}")

    def _merge_partial_research(
        self,
        new_refs: list,
        *,
        previous,
        context: StageContext,
    ) -> list:
        """Preserve rows for tickers a partial research refresh did not touch.

        A per-ticker refresh recomputes the research artifacts for that ticker
        only. Publishing those rows verbatim would replace the whole-watchlist
        artifact with a single row and make every other ticker look unresearched.
        """

        if previous is None or context.scope not in {"research", "all"}:
            return new_refs
        previous_by_key = {ref.key: ref for ref in previous.manifest.artifacts}
        merged_refs = []
        equities = _equity_tickers(self.artifacts, context)
        for ref in new_refs:
            if ref.key not in MERGEABLE_RESEARCH_KEYS:
                merged_refs.append(ref)
                continue
            previous_ref = previous_by_key.get(ref.key)
            if previous_ref is None:
                merged_refs.append(ref)
                continue
            try:
                previous_payload = self.artifacts.get_json(previous_ref.artifact_id).payload
                current = self.artifacts.get_json(ref.artifact_id)
            except (FileNotFoundError, KeyError, ValueError):
                merged_refs.append(ref)
                continue
            refreshed = tuple(current.payload.get("tickers") or ())
            if ref.key == "research/market_snapshot.json":
                if not refreshed and not (current.payload.get("options") or {}).get("tickers"):
                    continue
                merged_payload = merge_partial_market_snapshot(
                    previous_payload,
                    current.payload,
                    refreshed=refreshed,
                )
            else:
                if ref.key not in {
                    FUND_PRICES_KEY,
                    FUND_PRICE_DIRECTORY_KEY,
                    "research/technical.json",
                    "research/options.json",
                }:
                    if not equities and context.tickers:
                        continue
                    refreshed = equities or refreshed
                if not refreshed:
                    continue
                merged_payload = merge_partial_rows(
                    previous_payload,
                    current.payload,
                    refreshed=refreshed,
                )
            if ref.key == "research/analyst.json":
                merged_payload = bind_estimate_changes(
                    previous_payload,
                    merged_payload,
                    tuple(r["ticker"] for r in current.payload.get("rows", [])),
                )
            if ref.key == "research/technical.json":
                merged_payload = _retain_benchmarks(previous_payload, merged_payload)
            if merged_payload is current.payload:
                merged_refs.append(ref)
                continue
            merged_refs.append(
                self.artifacts.put_json(
                    key=ref.key,
                    payload=merged_payload,
                    kind=ref.kind,
                    as_of=ref.as_of,
                    producer_version=ref.producer_version,
                    dependency_artifact_ids=[previous_ref.artifact_id, ref.artifact_id],
                    quality=ref.quality,
                ).ref
            )
        return merged_refs

    def _merge_valuation_history_ref(
        self, previous_ref: ArtifactRef, ref: ArtifactRef, *, is_live: bool
    ) -> ArtifactRef:
        if previous_ref.artifact_id == ref.artifact_id or (
            previous_ref.artifact_id in ref.dependency_artifact_ids
        ):
            return ref
        try:
            prev_series = IntradayAnchorSeries.model_validate(
                self.artifacts.get_json(previous_ref.artifact_id).payload
            )
            inc_series = IntradayAnchorSeries.model_validate(
                self.artifacts.get_json(ref.artifact_id).payload
            )
        except (FileNotFoundError, KeyError, TypeError, ValueError):
            return ref
        if prev_series.interval_seconds != inc_series.interval_seconds:
            return ref
        merged_generated_at = max(
            prev_series.generated_at,
            inc_series.generated_at,
            max(
                (point.observed_at for point in prev_series.points),
                default=prev_series.generated_at,
            ),
            max(
                (point.observed_at for point in inc_series.points), default=inc_series.generated_at
            ),
        )
        retention_days = max(prev_series.retention_days, inc_series.retention_days)
        if is_live:
            broker_points = [point for point in inc_series.points if point.source == "broker"]
            merged = merge_valuation_history(
                prev_series,
                broker_points,
                generated_at=merged_generated_at,
                interval_seconds=inc_series.interval_seconds,
                retention_days=retention_days,
                replace_reconstructed=False,
            )
        else:
            broker_points = [point for point in prev_series.points if point.source == "broker"]
            merged = merge_valuation_history(
                inc_series,
                broker_points,
                generated_at=merged_generated_at,
                interval_seconds=inc_series.interval_seconds,
                retention_days=retention_days,
                replace_reconstructed=False,
            )
        if merged == inc_series:
            return ref
        if merged == prev_series:
            return previous_ref
        return self.artifacts.put_json(
            key=ref.key,
            payload=merged.model_dump(mode="json", by_alias=False),
            kind=ref.kind,
            as_of=(merged.points[-1].observed_at.isoformat() if merged.points else ref.as_of),
            producer_version=ref.producer_version,
            dependency_artifact_ids=list(
                dict.fromkeys([*ref.dependency_artifact_ids, previous_ref.artifact_id])
            ),
            quality=ref.quality,
        ).ref

    def _reconcile_cash_flows_ref(
        self, previous_ref: ArtifactRef, ref: ArtifactRef, *, is_live: bool
    ) -> ArtifactRef:
        if previous_ref.artifact_id == ref.artifact_id:
            return ref
        try:
            prev_flows = AccountCashFlowHistory.model_validate(
                self.artifacts.get_json(previous_ref.artifact_id).payload
            )
            inc_flows = AccountCashFlowHistory.model_validate(
                self.artifacts.get_json(ref.artifact_id).payload
            )
        except (FileNotFoundError, KeyError, TypeError, ValueError):
            return ref
        same_evidence = (
            prev_flows.verified
            and inc_flows.verified
            and prev_flows.source_digest == inc_flows.source_digest
            and prev_flows.account_state_digest == inc_flows.account_state_digest
            and prev_flows.events == inc_flows.events
        )
        if is_live:
            extends_current = previous_ref.artifact_id in ref.dependency_artifact_ids
            if (
                extends_current or same_evidence
            ) and inc_flows.covered_until > prev_flows.covered_until:
                return ref
            return previous_ref
        if same_evidence and prev_flows.covered_until > inc_flows.covered_until:
            return previous_ref
        return ref

    def _attribution_observation(
        self, ref: ArtifactRef, profile: str, as_of: datetime | None = None
    ) -> tuple[str, dict] | None:
        """Find the normalized observation behind a selected attribution row."""
        account_keys = {f"account/{profile}.json", f"account/intraday/{profile}.json"}
        pending = list(ref.dependency_artifact_ids)
        seen: set[str] = set()
        while pending:
            artifact_id = pending.pop()
            if artifact_id in seen:
                continue
            seen.add(artifact_id)
            try:
                dependency = self.artifacts.get_ref(artifact_id)
                if dependency.key == ref.key:
                    # Older merged artifacts link to the previous attribution ref.
                    pending.extend(dependency.dependency_artifact_ids)
                elif dependency.key in account_keys:
                    payload = self.artifacts.get_json(artifact_id).payload
                    observed_at = datetime.fromisoformat(payload["fetched_at"])
                    if as_of is None or observed_at == as_of:
                        return artifact_id, payload
            except (FileNotFoundError, KeyError, TypeError, ValueError):
                continue
        return None

    def _reconcile_attribution(
        self,
        previous: dict[str, ArtifactRef],
        incoming: dict[str, ArtifactRef],
        *,
        baseline_key: str,
        attribution_key: str,
    ) -> dict[str, ArtifactRef]:
        prev_baseline_ref = previous.get(baseline_key)
        baseline_ref = incoming.get(baseline_key)
        prev_ref = previous.get(attribution_key)
        ref = incoming.get(attribution_key)
        if any(item is None for item in (prev_baseline_ref, baseline_ref, prev_ref, ref)):
            return {}
        is_window = baseline_key == WINDOW_BASELINES_KEY
        baseline_cls = WindowBaselines if is_window else DayBaseline
        model_cls = WindowAttribution if is_window else DayAttribution
        try:
            old_base = baseline_cls.model_validate(
                self.artifacts.get_json(prev_baseline_ref.artifact_id).payload
            )
            new_base = baseline_cls.model_validate(
                self.artifacts.get_json(baseline_ref.artifact_id).payload
            )
            old_attr = model_cls.model_validate(
                self.artifacts.get_json(prev_ref.artifact_id).payload
            )
            new_attr = model_cls.model_validate(self.artifacts.get_json(ref.artifact_id).payload)
        except (FileNotFoundError, KeyError, TypeError, ValueError):
            return {}
        if new_attr.day < old_attr.day:
            return {baseline_key: prev_baseline_ref, attribution_key: prev_ref}
        baseline = (
            _merge_window_baselines(old_base, new_base)
            if is_window
            else _merge_day_baseline(old_base, new_base)
        )
        merged_base_ref = baseline_ref
        if baseline != new_base:
            merged_base_ref = (
                prev_baseline_ref
                if baseline == old_base
                else self._store_attribution(
                    baseline_ref, baseline, [prev_baseline_ref.artifact_id]
                )
            )

        def openings(model: DayBaseline | WindowBaselines, code: str) -> list:
            days = model.days if isinstance(model, WindowBaselines) else [model]
            return [entry.accounts[code] for entry in days if code in entry.accounts]

        accounts = {}
        dependencies = [merged_base_ref.artifact_id]
        for code, profile in ACCOUNT_PROFILES:
            row = new_attr.accounts.get(code)
            old_row = old_attr.accounts.get(code) if old_attr.day == new_attr.day else None
            incoming_time = row.as_of if row is not None else None
            if row is None and old_row is not None:
                unverified = self._attribution_observation(ref, profile)
                if unverified is not None:
                    incoming_time = datetime.fromisoformat(unverified[1]["fetched_at"])
            use_previous = (
                old_row is not None
                and incoming_time is not None
                and (
                    old_row.as_of > incoming_time
                    or (row is None and old_row.as_of == incoming_time)
                )
            )
            selected_row = old_row if use_previous else row
            if selected_row is None:
                continue
            selected_base = old_base if use_previous else new_base
            selected_ref = prev_ref if use_previous else ref
            observation = self._attribution_observation(selected_ref, profile, selected_row.as_of)
            if observation is not None:
                dependencies.append(observation[0])
            if openings(selected_base, code) == openings(baseline, code):
                accounts[code] = selected_row
            elif observation is not None:
                # The winning mark was calculated from another opening. Reuse
                # the regular attribution pipeline with the winning evidence.
                share_movements, _ = load_share_movements(self.snapshots.root, {code: profile})
                if is_window:
                    today = next(
                        (entry for entry in baseline.days if entry.day == new_attr.day), None
                    )
                    if today is None:
                        continue
                    _, recalculated = update_window_attribution(
                        baseline.model_dump(mode="json"),
                        today,
                        {code: observation[1]},
                        share_movements=share_movements,
                    )
                else:
                    _, recalculated = update_day_attribution(
                        baseline.model_dump(mode="json"),
                        {code: observation[1]},
                        share_movements=share_movements,
                    )
                if code in recalculated.accounts:
                    accounts[code] = recalculated.accounts[code]

        merged = new_attr.model_copy(update={"accounts": accounts})
        if merged == new_attr and merged_base_ref == baseline_ref:
            result = ref
        elif merged == old_attr and merged_base_ref == prev_baseline_ref:
            result = prev_ref
        else:
            result = self._store_attribution(
                ref,
                merged,
                [prev_ref.artifact_id, ref.artifact_id, *dependencies],
                keep_dependencies=False,
            )
        return {baseline_key: merged_base_ref, attribution_key: result}

    def _store_attribution(
        self, ref: ArtifactRef, payload, dependencies: list[str], *, keep_dependencies: bool = True
    ) -> ArtifactRef:
        return self.artifacts.put_json(
            key=ref.key,
            payload=payload.model_dump(mode="json", by_alias=False),
            kind=ref.kind,
            as_of=ref.as_of,
            producer_version=ref.producer_version,
            dependency_artifact_ids=list(
                dict.fromkeys(
                    [
                        *(ref.dependency_artifact_ids if keep_dependencies else ()),
                        *dependencies,
                    ]
                )
            ),
            quality=ref.quality,
        ).ref

    def _reconcile_concurrent_account_artifacts(
        self,
        new_refs: list[ArtifactRef],
        *,
        previous: StoredSnapshot | None,
        context: StageContext,
    ) -> list[ArtifactRef]:
        """Apply concurrent main/live conflict rules under ``publication_lock``."""

        if previous is None:
            return new_refs
        is_live = context.scope in {"intraday", "live"} or context.trigger in {"intraday", "live"}
        previous_by_key = {ref.key: ref for ref in previous.manifest.artifacts}
        incoming_by_key = {ref.key: ref for ref in new_refs}
        attribution = {}
        for baseline_key, attribution_key in (
            (DAY_BASELINE_KEY, DAY_ATTRIBUTION_KEY),
            (WINDOW_BASELINES_KEY, WINDOW_ATTRIBUTION_KEY),
        ):
            attribution.update(
                self._reconcile_attribution(
                    previous_by_key,
                    incoming_by_key,
                    baseline_key=baseline_key,
                    attribution_key=attribution_key,
                )
            )
        reconciled = []
        legacy_raw_keys = {
            broker_snapshot_key(profile, intraday=False) for profile in ("invest", "isa")
        }
        for ref in new_refs:
            previous_ref = previous_by_key.get(ref.key)
            if previous_ref is None:
                reconciled.append(ref)
            elif is_live and ref.key in legacy_raw_keys:
                # A resumed live job may carry the old shared raw key.
                reconciled.append(previous_ref)
            elif ref.key == VALUATION_HISTORY_KEY:
                reconciled.append(
                    self._merge_valuation_history_ref(previous_ref, ref, is_live=is_live)
                )
            elif ref.key in CASH_FLOW_KEYS:
                reconciled.append(
                    self._reconcile_cash_flows_ref(previous_ref, ref, is_live=is_live)
                )
            elif ref.key in attribution:
                reconciled.append(attribution[ref.key])
            else:
                reconciled.append(ref)
        return reconciled

    def run(self, context: StageContext) -> StageResult:
        if not context.upstream_artifact_ids:
            raise StageExecutionError(
                "snapshot.empty",
                "cannot publish a snapshot without upstream artifacts",
            )
        upstream_refs = [
            self.artifacts.get_ref(artifact_id) for artifact_id in context.upstream_artifact_ids
        ]
        estimate_batches = {}
        with self.snapshots.publication_lock():
            refs_by_key = {}
            previous = self.snapshots.latest()
            if previous is not None:
                if context.recovering_publication and previous.manifest.created_at > max(
                    ref.generated_at for ref in upstream_refs
                ):
                    raise StageExecutionError(
                        "snapshot.superseded",
                        "a newer snapshot was published after the recovered job's inputs",
                    )
                refs_by_key.update({ref.key: ref for ref in previous.manifest.artifacts})
            new_refs = self._merge_partial_research(
                upstream_refs,
                previous=previous,
                context=context,
            )
            new_refs = self._reconcile_concurrent_account_artifacts(
                new_refs,
                previous=previous,
                context=context,
            )
            current_etf = next((ref for ref in new_refs if ref.key == ETF_SUMMARY_KEY), None)
            if current_etf:
                old_summary = refs_by_key.get(ETF_SUMMARY_KEY)
                old_journal = refs_by_key.get(ETF_JOURNAL_KEY)
                journal = (
                    self.artifacts.get_json(old_journal.artifact_id).payload if old_journal else {}
                )
                old = (
                    ETFPortfolio.model_validate(
                        self.artifacts.get_json(old_summary.artifact_id).payload
                    )
                    if old_summary
                    else ETFPortfolio()
                )
                current = ETFPortfolio.model_validate(
                    self.artifacts.get_json(current_etf.artifact_id).payload
                )
                benchmark_ref = refs_by_key.get(ETF_BENCHMARKS_KEY)
                previous_benchmarks = (
                    self.artifacts.get_json(benchmark_ref.artifact_id).payload
                    if benchmark_ref
                    else {}
                )
                benchmarks = {
                    key: BenchmarkObservation.model_validate(row)
                    for key, row in previous_benchmarks.items()
                }
                updated = update_etf_journal(
                    journal,
                    old,
                    current,
                    current_etf.generated_at.isoformat(),
                    benchmarks=benchmarks,
                )
                benchmark_payload = {
                    key: row.model_dump(mode="json") for key, row in benchmarks.items()
                }
                if benchmark_payload != previous_benchmarks:
                    refs_by_key[ETF_BENCHMARKS_KEY] = self.artifacts.put_json(
                        key=ETF_BENCHMARKS_KEY,
                        kind="etf-benchmark-observations",
                        payload=benchmark_payload,
                        producer_version="etf-benchmark-observations-v1",
                        dependency_artifact_ids=[current_etf.artifact_id],
                    ).ref
                if updated != journal:
                    refs_by_key[ETF_JOURNAL_KEY] = self.artifacts.put_json(
                        key=ETF_JOURNAL_KEY,
                        kind="etf-journal",
                        payload=updated,
                        producer_version="etf-journal-v2",
                        dependency_artifact_ids=[current_etf.artifact_id],
                    ).ref
                # ETF evidence is a complete set for the current account selection.
                refs_by_key = {
                    key: ref
                    for key, ref in refs_by_key.items()
                    if not key.startswith(("account/etfs/", "account/etf_holdings/"))
                }
            refs_by_key.update({ref.key: ref for ref in new_refs})
            exposure = next(
                (ref for ref in new_refs if ref.key == "account/lookthrough_metrics.json"), None
            )
            if exposure:
                record_exposure(self.artifacts, refs_by_key, exposure)
            estimate_keys = (
                ESTIMATE_KEYS.intersection(ref.key for ref in new_refs)
                if self.estimate_history is not None
                and context.trigger in SCHEDULED_RESEARCH_TRIGGERS
                else frozenset()
            )
            if context.scope in {"all", "research"}:
                coverage: dict[str, dict] = {}
                for key, ref in refs_by_key.items():
                    if key not in MERGEABLE_RESEARCH_KEYS or key in {
                        "research/market_snapshot.json",
                        FUND_PRICES_KEY,
                        FUND_PRICE_DIRECTORY_KEY,
                    }:
                        continue
                    raw = self.artifacts.get_json(ref.artifact_id).payload
                    if key in estimate_keys:
                        estimate_batches[key] = raw
                    name = key.removeprefix("research/").removesuffix(".json")
                    for ticker, clock in row_clocks(
                        raw, generated_at=ref.generated_at.isoformat()
                    ).items():
                        coverage.setdefault(ticker, {})[name] = clock
                capability_ref = self.artifacts.put_json(
                    key="research/coverage.json",
                    payload={
                        "rows": [
                            {"ticker": ticker, "datasets": datasets}
                            for ticker, datasets in coverage.items()
                        ]
                    },
                    kind="research-coverage",
                    producer_version="research-coverage-v1",
                ).ref
                refs_by_key[capability_ref.key] = capability_ref
            refs = list(refs_by_key.values())
            published = self.snapshots.publish(
                scope=context.scope,
                source=f"{context.trigger}:{context.job_id}",
                artifacts=refs,
                prepare=context.prepare_publication,
            )
        if self.estimate_history is not None and estimate_batches.keys() == ESTIMATE_KEYS:
            observed_at = published.manifest.created_at
            try:
                self.estimate_history.recover(self.snapshots, before=observed_at)
            except Exception:
                LOGGER.exception("estimate history recovery failed")
            try:
                self.estimate_history.append(
                    estimate_observations(
                        estimate_batches[FUNDAMENTALS_KEY],
                        estimate_batches[ANALYST_KEY],
                        observed_at=observed_at,
                    )
                )
            except Exception:
                # The archive is additive; preserve the complete research publication.
                LOGGER.exception("estimate history append failed")
        if self.on_snapshot_published is not None and context.trigger not in {"intraday", "live"}:
            # Synthesis is additive. A provider or queue outage must not
            # invalidate an otherwise complete portfolio snapshot.
            with suppress(Exception):
                self.on_snapshot_published(published, context.trigger)
        return StageResult(metadata={"snapshot_run_id": published.manifest.run_id})


__all__ = ["TechnicalResearchStage", "TypedPublishSnapshotStage"]
