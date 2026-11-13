"""Durable worker stages for typed market research."""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime

from trading_max.analytics.etf_journal import (
    ETF_BENCHMARKS_KEY,
    ETF_JOURNAL_KEY,
    BenchmarkObservation,
    update_etf_journal,
)
from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY, ETFPortfolio
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
    StoredSnapshot,
)
from trading_max.reference import CatalogSecurityMaster, SecurityMasterCatalog, is_fund_instrument
from trading_max.research.coverage import merge_rows, row_clocks
from trading_max.research.estimate_history import (
    ANALYST_KEY,
    ESTIMATE_KEYS,
    FUNDAMENTALS_KEY,
    SCHEDULED_RESEARCH_TRIGGERS,
    EstimateHistory,
    estimate_observations,
)
from trading_max.research.fund_references import US_MARKETS, fund_peers, us_fund, us_fund_listing
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

from .errors import StageExecutionError
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
    version = "fund-prices-v2"
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
        rows = [
            {
                "ticker": row["ticker"],
                **listings[row["ticker"]],
                "as_of": row["as_of"],
                "spot": row["price"],
                "currency": row["currency"],
                "exchange": row["exchange"],
                "timezone": row["timezone"],
                "price_series": row["price_series"],
            }
            for row in batch["rows"]
            if row["ticker"] in listings
        ]
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
    version = "market-snapshot-v12"
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
                    listing.ticker == ticker
                    and (listing.mic in US_MARKETS or listing.exchange.upper() in US_MARKETS)
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
    version = "valuation-v6"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical", "research.fundamentals", "research.financials")

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore | None = None,
        *,
        fx_loader=None,
        assumptions_store=None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.fx_loader = fx_loader
        self.assumptions_store = assumptions_store

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
            batch = build_valuation(
                {**technical.payload, "tickers": list(equities)},
                fundamentals.payload,
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

    def run(self, context: StageContext) -> StageResult:
        if not context.upstream_artifact_ids:
            raise StageExecutionError(
                "snapshot.empty",
                "cannot publish a snapshot without upstream artifacts",
            )
        new_refs = [
            self.artifacts.get_ref(artifact_id) for artifact_id in context.upstream_artifact_ids
        ]
        refs_by_key = {}
        previous = self.snapshots.latest()
        if previous is not None:
            refs_by_key.update({ref.key: ref for ref in previous.manifest.artifacts})
        new_refs = self._merge_partial_research(
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
                self.artifacts.get_json(benchmark_ref.artifact_id).payload if benchmark_ref else {}
            )
            benchmarks = {
                key: BenchmarkObservation.model_validate(row)
                for key, row in previous_benchmarks.items()
            }
            updated = update_etf_journal(
                journal, old, current, current_etf.generated_at.isoformat(), benchmarks=benchmarks
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
        estimate_batches = {}
        estimate_keys = (
            ESTIMATE_KEYS.intersection(ref.key for ref in new_refs)
            if self.estimate_history is not None and context.trigger in SCHEDULED_RESEARCH_TRIGGERS
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
        if self.on_snapshot_published is not None and context.trigger != "intraday":
            # Synthesis is additive. A provider or queue outage must not
            # invalidate an otherwise complete portfolio snapshot.
            with suppress(Exception):
                self.on_snapshot_published(published, context.trigger)
        return StageResult(metadata={"snapshot_run_id": published.manifest.run_id})


__all__ = ["TechnicalResearchStage", "TypedPublishSnapshotStage"]
