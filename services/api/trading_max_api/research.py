"""Build ticker research projections from validated immutable artifacts."""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.facts import (
    DatasetClock,
    ResearchCapability,
    ResearchContext,
    build_financial_facts,
    fingerprint,
    make_quote,
)
from trading_max.research.option_terms import chain_availability

from .artifacts import ArtifactStore
from .dashboard import _option_rows, _technical_rows, _valuation_rows
from .dashboard_models import (
    PriceSeriesPoint,
    ResearchDirectoryInstrument,
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchPriceSeries,
    ResearchShell,
    ResearchTradeMarker,
)
from .models import (
    ArtifactInfo,
    PortfolioImpact,
    ResearchAlert,
    ResearchArtifactState,
    ResearchEvent,
    ResearchInstrument,
    ResearchModelRun,
    ResearchOverview,
    ResearchStatus,
    ResearchTickerSnapshot,
    ResearchTimelinePoint,
    SnapshotManifest,
)
from .watchlist import WatchlistStore

if TYPE_CHECKING:
    from .alert_monitor import LiveAlertStore


JsonObject = dict[str, Any]

FRESHNESS_DAYS: dict[str, tuple[float, float]] = {
    "account": (2.0, 4.0),
    "market": (2.0, 4.0),
    "technical": (2.0, 4.0),
    "options": (1.0, 2.0),
    "valuation": (7.0, 14.0),
    "fundamentals": (7.0, 14.0),
    "analyst": (7.0, 14.0),
    "financials": (90.0, 180.0),
    "earnings": (45.0, 100.0),
    "taxonomy": (30.0, 90.0),
    "sources": (45.0, 100.0),
    "assumptions": (90.0, 180.0),
    "artifact": (7.0, 14.0),
}

SOURCE_TERMS: dict[str, tuple[str, ...]] = {
    "AAPL": ("apple",),
    "AMZN": ("amazon",),
    "ARM": ("arm_",),
    "BE": ("be_", "bloom"),
    "LRCX": ("lrcx", "lam"),
    "META": ("meta",),
    "MSFT": ("microsoft",),
    "SMSN": ("samsung",),
    "VRT": ("vrt_", "vertiv"),
}

CURRENT_MARKET_KEY = "research/market_snapshot.json"
LEGACY_MARKET_KEY = "research/daily_market.json"


def _artifact(
    manifest: SnapshotManifest,
    key: str,
) -> ArtifactInfo | None:
    return next((item for item in manifest.artifacts if item.key == key), None)


def _kind(artifact: ArtifactInfo) -> str:
    if artifact.kind != "artifact":
        return artifact.kind
    if artifact.key.startswith("account/"):
        return "account"
    name = artifact.key.rsplit("/", 1)[-1].removesuffix(".json")
    return {
        "daily_market": "market",
        "technical": "technical",
        "options": "options",
        "valuation": "valuation",
        "earnings": "earnings",
        "analyst": "analyst",
        "financials": "financials",
        "sources": "sources",
        "valuation_assumptions": "assumptions",
    }.get(name, "artifact")


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _business_day_age(observed: date, current: date) -> float:
    if observed >= current:
        return 0.0
    days = 0
    cursor = observed
    while cursor < current:
        cursor = date.fromordinal(cursor.toordinal() + 1)
        if cursor.weekday() < 5:
            days += 1
    return float(days)


def _freshness(artifact: ArtifactInfo, now: datetime) -> tuple[float | None, str]:
    observed = _parse_date(artifact.data_as_of)
    if observed is None and artifact.generated_at is not None:
        observed = artifact.generated_at.date()
    if observed is None:
        return None, "unknown"
    kind = _kind(artifact)
    if kind in {"market", "technical", "options", "valuation"}:
        age = _business_day_age(observed, now.date())
    else:
        age = max((now.date() - observed).total_seconds() / 86_400, 0.0)
    fresh_days, aging_days = FRESHNESS_DAYS.get(
        kind,
        FRESHNESS_DAYS["artifact"],
    )
    if age <= fresh_days:
        return age, "fresh"
    if age <= aging_days:
        return age, "aging"
    return age, "stale"


def _market_rows(raw: JsonObject) -> list[JsonObject]:
    typed_technical = raw.get("technical")
    if isinstance(typed_technical, dict):
        return [
            {
                "ticker": str(row.get("ticker") or ""),
                "currency": str(row.get("currency") or ""),
                "spot": row.get("price"),
                "held": False,
                "asOf": row.get("as_of") or raw.get("as_of"),
            }
            for row in typed_technical.get("rows", [])
            if isinstance(row, dict)
        ]
    return [
        {
            "ticker": str(row.get("t")),
            "currency": str(row.get("ccy") or ""),
            "spot": row.get("spot"),
            "enterpriseValue": row.get("ev"),
            "forwardPe": row.get("fpe"),
            "analystMedian": row.get("med"),
            "analystUpside": row.get("aup"),
            "dayReturn": row.get("day"),
            "modelValue": row.get("mdl"),
            "held": bool(row.get("held")),
            "asOf": raw.get("as_of"),
        }
        for row in raw.get("rows", [])
    ]


def _fundamentals_rows(raw: JsonObject) -> list[JsonObject]:
    typed_rows = raw.get("rows")
    if isinstance(typed_rows, list):
        return [dict(row) for row in typed_rows if isinstance(row, dict)]
    return [dict(row) for row in raw.get("fundamentals", []) if isinstance(row, dict)]


def _analyst_rows(raw: JsonObject) -> list[JsonObject]:
    rows = raw.get("rows")
    return [dict(row) for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _financials_rows(raw: JsonObject) -> list[JsonObject]:
    rows = raw.get("rows")
    return [dict(row) for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _canonical_ticker(value: str) -> str:
    ticker = value.upper()
    return ticker[:-2] if ticker.endswith(".L") else ticker


def _account_exposure(
    broker: JsonObject, lookthrough: JsonObject
) -> tuple[set[str], dict[str, float]]:
    direct: dict[str, float] = {}
    for account in broker.get("accounts", {}).values():
        for position in account.get("positions", []):
            key = _canonical_ticker(str(position.get("ticker") or ""))
            direct[key] = direct.get(key, 0.0) + float(position.get("current_value_gbp") or 0.0)
    exposure = dict(direct)
    # Fund units are replaced by constituents in look-through rows, so their
    # direct broker values must remain available in the research directory.
    for position in lookthrough.get("positions", []):
        key = _canonical_ticker(str(position.get("ticker") or ""))
        exposure[key] = float(position.get("valueGbp") or direct.get(key, 0.0))
    return set(direct), exposure


def _find(rows: list[JsonObject], ticker: str) -> JsonObject | None:
    exact = next(
        (row for row in rows if str(row.get("ticker", "")).upper() == ticker.upper()), None
    )
    if exact is not None:
        return exact
    return next(
        (
            row
            for row in rows
            if _canonical_ticker(str(row.get("ticker", ""))) == _canonical_ticker(ticker)
        ),
        None,
    )


def _normalized_earnings_calendar(row: JsonObject | None) -> JsonObject | None:
    if not row:
        return None
    raw = row.get("calendar")
    if not isinstance(raw, dict) or not raw:
        return None
    calendar = dict(raw)
    earnings_dates = calendar.get("Earnings Date")
    if isinstance(earnings_dates, list):
        calendar["earningsDates"] = [str(item) for item in earnings_dates]
    elif earnings_dates:
        calendar["earningsDates"] = [str(earnings_dates)]
    return calendar


def _enrich_fundamentals(
    fundamentals: list[JsonObject],
    earnings_raw: JsonObject,
    technical_raw: JsonObject,
    analyst_raw: JsonObject | None = None,
) -> list[JsonObject]:
    earnings_rows = [dict(row) for row in earnings_raw.get("rows", []) if isinstance(row, dict)]
    technical_rows = _technical_rows(technical_raw)
    analyst_rows = _analyst_rows(analyst_raw) if analyst_raw else []
    enriched: list[JsonObject] = []
    for row in fundamentals:
        ticker = str(row.get("ticker") or "")
        item = dict(row)
        calendar = _normalized_earnings_calendar(_find(earnings_rows, ticker))
        if calendar is not None:
            item["earningsCalendar"] = calendar
        technical = _find(technical_rows, ticker)
        if technical is not None:
            item["seasonality"] = list(technical.get("seasonality") or [])
            item["seasonalityCoverage"] = dict(technical.get("seasonalityCoverage") or {})
            item["seasonalityMatrix"] = list(technical.get("seasonalityMatrix") or [])
            item["yearPaths"] = dict(technical.get("yearPaths") or {})
        # Reported-versus-estimate history lives in the analyst artifact; the
        # earnings calendar only carries the upcoming event, which left the
        # fundamentals earnings card with a date and nothing else.
        analyst_row = _find(analyst_rows, ticker)
        if analyst_row is not None:
            analyst = analyst_row.get("analyst")
            if isinstance(analyst, dict):
                history = analyst.get("earningsHistory")
                if isinstance(history, list) and history:
                    item["earningsHistory"] = [
                        {
                            "date": str(entry.get("quarter") or "")[:10],
                            "epsEstimate": entry.get("epsEstimate"),
                            "epsReported": entry.get("epsActual"),
                            "surprisePct": (
                                float(entry["surprisePercent"]) * 100
                                if isinstance(entry.get("surprisePercent"), int | float)
                                else None
                            ),
                        }
                        for entry in history
                        if isinstance(entry, dict)
                    ]
        enriched.append(item)
    return enriched


class ResearchLedger:
    def __init__(
        self,
        store: ArtifactStore,
        watchlist: WatchlistStore,
        live_alerts: LiveAlertStore | None = None,
    ) -> None:
        self.store = store
        self.watchlist = watchlist
        self.live_alerts = live_alerts
        # Historical artifacts are content addressed and immutable, so parsed
        # rows can be memoized by sha256. The timeline and model history walk
        # the same handful of artifacts across many snapshots; without this the
        # research overview re-parses every research JSON per snapshot.
        self._facts_cache: SingleFlightCache[tuple, Any] = SingleFlightCache(128)
        self._row_cache: SingleFlightCache[tuple, list[JsonObject]] = SingleFlightCache(256)
        self._raw_price_cache: SingleFlightCache[str, JsonObject] = SingleFlightCache(2)
        self._price_series_cache: dict[
            tuple[str, str, str],
            tuple[str, str, list[PriceSeriesPoint], list[ResearchTradeMarker]],
        ] = {}
        self._history_lock = threading.RLock()
        self._history_signature: tuple[str | None, ...] | None = None
        self._history_manifests_cache: list[SnapshotManifest] = []

    def _history_manifests(self) -> list[SnapshotManifest]:
        """Reuse research history while intraday-only snapshots are published."""

        latest = self.store.latest_manifest()
        if latest is None:
            return []
        keys = (
            "research/daily_market.json",
            "research/market_snapshot.json",
            "research/technical.json",
            "research/options.json",
            "research/valuation.json",
            "research/earnings.json",
        )
        signature = tuple(
            artifact.sha256 if (artifact := _artifact(latest, key)) is not None else None
            for key in keys
        )
        with self._history_lock:
            if self._history_signature == signature:
                return self._history_manifests_cache
            manifests = self.store.list_manifests(limit=500)
            self._history_signature = signature
            self._history_manifests_cache = manifests
            return manifests

    def prewarm_history(self) -> None:
        """Prime the immutable research-history index outside request latency."""

        self._history_manifests()

    def _read_optional(
        self,
        manifest: SnapshotManifest,
        key: str,
    ) -> JsonObject:
        try:
            return self.store.read_json(manifest.run_id, key)
        except FileNotFoundError:
            return {}

    def _cached_rows(
        self,
        manifest: SnapshotManifest,
        key: str,
        parser: Callable[[JsonObject], list[JsonObject]],
        *,
        fallback_key: str | None = None,
    ) -> list[JsonObject]:
        """Parse an artifact once per content hash.

        ``fallback_key`` mirrors the original read semantics: fall back when the
        primary payload is missing *or* empty. Snapshots that do not describe
        the artifact in their manifest (tests, legacy runs) are read directly
        and simply skip the cache.
        """

        for candidate in (key, fallback_key):
            if candidate is None:
                continue
            artifact = _artifact(manifest, candidate)
            cache_key = (artifact.sha256, candidate) if artifact is not None else None
            cached = (
                self._row_cache.get_or_compute(
                    cache_key,
                    lambda candidate=candidate: parser(self._read_optional(manifest, candidate)),
                )
                if cache_key is not None
                else parser(self._read_optional(manifest, candidate))
            )
            if cached:
                return cached
        return []

    def _market_rows(self, manifest: SnapshotManifest) -> list[JsonObject]:
        """Read the typed market snapshot, retaining legacy-only compatibility."""

        rows = self._cached_rows(
            manifest,
            CURRENT_MARKET_KEY,
            _market_rows,
            fallback_key=LEGACY_MARKET_KEY,
        )
        # Compact quote metadata lives in fundamentals. Older technical batches
        # defaulted to USD; the provider's explicit quote currency takes precedence.
        # Do not load financial statements, options or the full research bundle.
        fundamentals = self._cached_rows(manifest, "research/fundamentals.json", _fundamentals_rows)
        enriched = []
        for row in rows:
            fundamental = _find(fundamentals, str(row.get("ticker", ""))) or {}
            metrics = fundamental.get("metrics") or fundamental.get("info") or {}
            quote_currency = str(fundamental.get("currency") or metrics.get("currency") or "")
            in_pence = quote_currency in {"GBp", "GBX"}
            if in_pence:
                quote_currency = "GBP"
            enriched.append(
                {
                    **row,
                    "currency": quote_currency or row.get("currency") or "",
                    **{
                        target: (
                            metrics[source] / 100
                            if in_pence and target == "analystMedian"
                            else metrics[source]
                        )
                        for target, source in (
                            ("enterpriseValue", "enterpriseValue"),
                            ("forwardPe", "forwardPE"),
                            ("analystMedian", "targetMedianPrice"),
                            ("quoteType", "quoteType"),
                        )
                        if metrics.get(source) is not None
                    },
                }
            )
        return enriched

    def _route_ticker(self, ticker: str) -> str:
        """Keep exchange-qualified watchlist identities in links and responses."""
        ticker = ticker.strip().upper()
        items = self.watchlist.items()
        if any(item.ticker == ticker for item in items):
            return ticker
        matches = [
            item.ticker
            for item in items
            if _canonical_ticker(item.ticker) == _canonical_ticker(ticker)
        ]
        return matches[0] if len(matches) == 1 else ticker

    def status(
        self,
        manifest: SnapshotManifest,
        *,
        now: datetime | None = None,
    ) -> ResearchStatus:
        now = now or datetime.now(UTC)
        states: list[ResearchArtifactState] = []
        rank = {"unknown": 0, "fresh": 1, "aging": 2, "stale": 3}
        overall = "unknown"
        has_current_market = _artifact(manifest, CURRENT_MARKET_KEY) is not None
        for artifact in manifest.artifacts:
            if not artifact.key.startswith("research/"):
                continue
            # ``daily_market.json`` was the pre-typed market artifact. Once a
            # typed market snapshot exists it is superseded, not a second
            # freshness requirement for the same data boundary.
            if artifact.key == LEGACY_MARKET_KEY and has_current_market:
                continue
            age, freshness = _freshness(artifact, now)
            warnings = list(artifact.warnings)
            if freshness == "stale":
                warnings.append(f"{artifact.key} is {age:.0f} days old")
            states.append(
                ResearchArtifactState(
                    key=artifact.key,
                    kind=_kind(artifact),
                    data_as_of=artifact.data_as_of,
                    generated_at=artifact.generated_at,
                    age_days=age,
                    freshness=freshness,
                    source_kind=artifact.source_kind,
                    model_version=artifact.model_version,
                    warnings=warnings,
                )
            )
            if rank[freshness] > rank[overall]:
                overall = freshness
        return ResearchStatus(
            run_id=manifest.run_id,
            generated_at=manifest.created_at,
            overall_freshness=overall,
            artifacts=states,
        )

    def instruments(
        self,
        manifest: SnapshotManifest,
    ) -> list[ResearchInstrument]:
        market = self._market_rows(manifest)
        technical = _technical_rows(self._read_optional(manifest, "research/technical.json"))
        valuations = _valuation_rows(self._read_optional(manifest, "research/valuation.json"))
        options_raw = self._read_optional(manifest, "research/options.json")
        if not options_raw:
            options_raw = self._read_optional(manifest, "research/technical.json")
        options = _option_rows(options_raw)
        earnings_raw = self._read_optional(manifest, "research/earnings.json")
        earnings = earnings_raw.get("companies", {})
        if not earnings and isinstance(earnings_raw.get("rows"), list):
            earnings = {
                str(row.get("ticker")): row
                for row in earnings_raw["rows"]
                if isinstance(row, dict) and row.get("ticker")
            }
        fundamentals = _fundamentals_rows(
            self._read_optional(manifest, "research/fundamentals.json")
        )
        broker = self._read_optional(manifest, "account/broker_snapshot_metrics.json")
        lookthrough = self._read_optional(manifest, "account/lookthrough_metrics.json")

        held, exposure = _account_exposure(broker, lookthrough)
        market_tickers = {_canonical_ticker(str(row["ticker"])) for row in market}
        technical_tickers = {_canonical_ticker(str(row["ticker"])) for row in technical}
        valuation_tickers = {_canonical_ticker(str(row["ticker"])) for row in valuations}
        option_tickers = {_canonical_ticker(str(row["ticker"])) for row in options}
        earnings_tickers = (
            {_canonical_ticker(str(ticker)) for ticker in earnings}
            if isinstance(earnings, dict)
            else set()
        )
        fundamentals_tickers = {_canonical_ticker(str(row["ticker"])) for row in fundamentals}
        fundamental_by_ticker = {
            _canonical_ticker(str(row.get("ticker", ""))): row for row in fundamentals
        }
        return [
            ResearchInstrument(
                ticker=item.ticker,
                name=item.name,
                exchange=item.exchange,
                website=str(
                    (
                        fundamental_by_ticker.get(_canonical_ticker(item.ticker), {}).get("metrics")
                        or {}
                    ).get("website")
                    or ""
                ),
                bloomberg_ticker=item.bloomberg_ticker,
                figi=item.figi,
                category_id=item.category_id,
                research_theme_id=item.research_theme_id,
                taxonomy_status=item.taxonomy_status,
                taxonomy_label_zh=item.taxonomy_label_zh,
                taxonomy_label_en=item.taxonomy_label_en,
                taxonomy_version=item.taxonomy_version,
                taxonomy_decision_id=item.taxonomy_decision_id,
                gics=item.gics,
                order=item.order,
                status=(
                    item.status
                    if item.status in {"running", "failed"}
                    else "ready"
                    if _canonical_ticker(item.ticker) in market_tickers
                    and _canonical_ticker(item.ticker) in technical_tickers
                    else "partial"
                    if _canonical_ticker(item.ticker)
                    in (
                        market_tickers
                        | technical_tickers
                        | valuation_tickers
                        | option_tickers
                        | earnings_tickers
                    )
                    else "pending"
                ),
                last_run_id=item.last_run_id,
                last_error=item.last_error,
                has_market=_canonical_ticker(item.ticker) in market_tickers,
                has_technical=_canonical_ticker(item.ticker) in technical_tickers,
                has_options=_canonical_ticker(item.ticker) in option_tickers,
                has_valuation=_canonical_ticker(item.ticker) in valuation_tickers,
                has_earnings=_canonical_ticker(item.ticker) in earnings_tickers,
                has_fundamentals=_canonical_ticker(item.ticker) in fundamentals_tickers,
                held=_canonical_ticker(item.ticker) in held,
                exposure_gbp=exposure.get(_canonical_ticker(item.ticker), 0.0),
            )
            for item in self.watchlist.items()
        ]

    def events(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> list[ResearchEvent]:
        ticker = _canonical_ticker(ticker)
        raw = self._read_optional(manifest, "research/earnings.json")
        companies = raw.get("companies", {})
        if not companies and isinstance(raw.get("rows"), list):
            company = next(
                (
                    row
                    for row in raw["rows"]
                    if isinstance(row, dict)
                    and _canonical_ticker(str(row.get("ticker") or "")) == ticker
                ),
                None,
            )
            if company is not None:
                return [
                    ResearchEvent(
                        ticker=ticker,
                        as_of=str(raw.get("as_of") or manifest.created_at.date()),
                        event_type="earnings",
                        title=f"{ticker} earnings calendar refresh",
                        summary=None,
                        data=company,
                        sources=[],
                    )
                ]
        company = companies.get(ticker) if isinstance(companies, dict) else None
        if not isinstance(company, dict):
            return []
        source_map = raw.get("sources", {})
        terms = SOURCE_TERMS.get(ticker, (ticker.lower(),))
        sources = [
            {"name": str(name), "url": str(url)}
            for name, url in source_map.items()
            if any(term in str(name).lower() for term in terms)
        ]
        summary = company.get("valuation_note")
        if summary is None:
            guidance = company.get("fy2026_guidance")
            if isinstance(guidance, dict):
                summary = "; ".join(f"{key}: {value}" for key, value in list(guidance.items())[:3])
        return [
            ResearchEvent(
                ticker=ticker,
                as_of=str(raw.get("as_of") or manifest.created_at.date()),
                event_type="earnings",
                title=f"{ticker} earnings & guidance refresh",
                summary=str(summary) if summary else None,
                data=company,
                sources=sources,
            )
        ]

    def portfolio_impact(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> PortfolioImpact:
        ticker = _canonical_ticker(ticker)
        broker = self._read_optional(manifest, "account/broker_snapshot_metrics.json")
        total_value = sum(
            float(account.get("total_value_gbp") or 0.0)
            for account in broker.get("accounts", {}).values()
        )
        direct_from_broker = sum(
            float(position.get("current_value_gbp") or 0.0)
            for account in broker.get("accounts", {}).values()
            for position in account.get("positions", [])
            if _canonical_ticker(str(position.get("ticker", ""))) == ticker
        )
        holding_accounts = [
            str(code)
            for code, account in broker.get("accounts", {}).items()
            if any(
                _canonical_ticker(str(position.get("ticker", ""))) == ticker
                and float(position.get("current_value_gbp") or 0.0) > 0
                for position in account.get("positions", [])
            )
        ]
        lookthrough = self._read_optional(manifest, "account/lookthrough_metrics.json")
        position = next(
            (
                item
                for item in lookthrough.get("positions", [])
                if _canonical_ticker(str(item.get("ticker", ""))) == ticker
            ),
            {},
        )
        direct = float(position.get("directValueGbp") or direct_from_broker)
        indirect = float(position.get("indirectValueGbp") or 0.0)
        exposure = float(position.get("valueGbp") or direct + indirect)
        fund_sources = {str(s.get("ticker", "")): s for s in lookthrough.get("sources", [])}
        contributors = [
            {
                **item,
                "asOf": fund_sources.get(str(item.get("ticker", "")), {}).get("asOf"),
                "sourceUrl": fund_sources.get(str(item.get("ticker", "")), {}).get("sourceUrl"),
            }
            for item in position.get("etfContributors", [])
        ]
        return PortfolioImpact(
            ticker=ticker,
            total_value_gbp=total_value,
            direct_value_gbp=direct,
            indirect_value_gbp=indirect,
            exposure_value_gbp=exposure,
            allocation_pct=exposure / total_value if total_value else 0.0,
            held=bool(holding_accounts),
            holding_accounts=holding_accounts,
            country=position.get("country"),
            industry=position.get("industry"),
            etf_contributors=contributors,
        )

    def ticker_snapshot(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> ResearchTickerSnapshot:
        ticker = self._route_ticker(ticker)
        market = _find(self._market_rows(manifest), ticker)
        technical = _find(
            self._cached_rows(manifest, "research/technical.json", _technical_rows),
            ticker,
        )
        valuation = _find(
            self._cached_rows(manifest, "research/valuation.json", _valuation_rows),
            ticker,
        )
        options = _find(
            self._cached_rows(
                manifest,
                "research/options.json",
                _option_rows,
                fallback_key="research/technical.json",
            ),
            ticker,
        )
        fundamentals = _find(
            _enrich_fundamentals(
                _fundamentals_rows(
                    self._read_optional(
                        manifest,
                        "research/fundamentals.json",
                    )
                ),
                self._read_optional(manifest, "research/earnings.json"),
                self._read_optional(manifest, "research/technical.json"),
                self._read_optional(manifest, "research/analyst.json"),
            ),
            ticker,
        )
        analyst_row = _find(
            self._cached_rows(manifest, "research/analyst.json", _analyst_rows),
            ticker,
        )
        analyst = analyst_row.get("analyst") if analyst_row else None
        financials_row = _find(
            self._cached_rows(manifest, "research/financials.json", _financials_rows),
            ticker,
        )
        financials = financials_row.get("financials") if financials_row else None
        events = self.events(ticker, manifest)
        return ResearchTickerSnapshot(
            ticker=ticker,
            run_id=manifest.run_id,
            generated_at=manifest.created_at,
            market=market,
            technical=(
                {**technical, "currency": market.get("currency") or ""}
                if technical and market
                else technical
            ),
            valuation=valuation,
            options=options,
            fundamentals=fundamentals,
            analyst=analyst,
            financials=financials,
            latest_event=events[0] if events else None,
            portfolio_impact=self.portfolio_impact(ticker, manifest),
        )

    def shell(self, manifest: SnapshotManifest) -> ResearchShell:
        """Return only the data needed before an individual lens is selected."""

        return ResearchShell(
            status=self.status(manifest),
            watchlist_categories=self.watchlist.categories(),
            instruments=self.directory_instruments(manifest),
        )

    def directory_instruments(
        self,
        manifest: SnapshotManifest,
    ) -> list[ResearchDirectoryInstrument]:
        """Build the ticker picker without decoding research artifacts.

        The legacy instrument endpoint exposes per-artifact capability flags
        and therefore inspects the large technical, valuation and fundamentals
        payloads. The initial workbench only needs durable watchlist metadata
        and account exposure; reading those artifacts here would defeat
        progressive loading before a lens is selected.
        """

        broker = self._read_optional(manifest, "account/broker_snapshot_metrics.json")
        lookthrough = self._read_optional(manifest, "account/lookthrough_metrics.json")
        held, exposure = _account_exposure(broker, lookthrough)
        return [
            ResearchDirectoryInstrument(
                ticker=item.ticker,
                name=item.name,
                exchange=item.exchange,
                bloomberg_ticker=item.bloomberg_ticker,
                figi=item.figi,
                category_id=item.category_id,
                research_theme_id=item.research_theme_id,
                taxonomy_status=item.taxonomy_status,
                taxonomy_label_zh=item.taxonomy_label_zh,
                taxonomy_label_en=item.taxonomy_label_en,
                taxonomy_version=item.taxonomy_version,
                taxonomy_decision_id=item.taxonomy_decision_id,
                gics=item.gics,
                order=item.order,
                status=item.status,
                last_run_id=item.last_run_id,
                last_error=item.last_error,
                held=_canonical_ticker(item.ticker) in held,
                exposure_gbp=exposure.get(_canonical_ticker(item.ticker), 0.0),
            )
            for item in self.watchlist.items()
        ]

    def lens_revision(self, manifest: SnapshotManifest, view: str, detail: str) -> str:
        """Account-only snapshots must not invalidate immutable company research."""
        common = {
            CURRENT_MARKET_KEY,
            LEGACY_MARKET_KEY,
            "research/fundamentals.json",
            "research/coverage.json",
        }
        keys = common | {
            "overview": {
                "research/financials.json",
                "research/earnings.json",
                "research/valuation.json",
                "research/technical.json",
            },
            "technical": {"research/technical.json", "research/earnings.json"},
            "valuation": {"research/financials.json", "research/valuation.json"},
            "fundamentals": {
                "research/financials.json",
                "research/earnings.json",
                "research/technical.json",
                "research/analyst.json",
            },
            "analyst": {"research/financials.json", "research/analyst.json"},
            "options": {"research/options.json", "research/technical.json"},
        }.get(view, set())
        # Exposure and historical records depend on the complete snapshot.
        refs = [
            (a.key, a.sha256)
            for a in manifest.artifacts
            if view in {"overview", "ledger"} or a.key in keys
        ]
        return (
            fingerprint([sorted(refs), detail, datetime.now(UTC).date().isoformat()])
            if refs
            else manifest.run_id
        )

    def lens_snapshot(
        self,
        ticker: str,
        view: ResearchLensName,
        manifest: SnapshotManifest,
        *,
        limit: int = 30,
        detail: str = "full",
    ) -> ResearchLensSnapshot:
        """Build one independently loadable research lens.

        The legacy ticker snapshot remains available for API compatibility, but
        the web workbench uses this scoped response so opening valuation never
        parses financial statements, options, timeline history, or unrelated
        portfolio data.
        """

        ticker = self._route_ticker(ticker)
        market = _find(self._market_rows(manifest), ticker)
        payload = ResearchLensSnapshot(
            ticker=ticker,
            view=view,
            run_id=manifest.run_id,
            generated_at=manifest.created_at.isoformat(),
            market=market,
        )
        fundamental = (
            _find(
                self._cached_rows(manifest, "research/fundamentals.json", _fundamentals_rows),
                ticker,
            )
            or {}
        )
        metrics = fundamental.get("metrics") or {}
        asset_type = str(metrics.get("quoteType") or "UNKNOWN").upper()
        is_fund = asset_type in {"ETF", "MUTUALFUND"}
        is_financial = any(
            word in str(fundamental.get("industry") or metrics.get("industry") or "").lower()
            for word in ("banks", "banking", "insurance")
        )
        coverage_row = _find(
            self._cached_rows(manifest, "research/coverage.json", _fundamentals_rows), ticker
        )
        dataset_coverage = coverage_row.get("datasets", {}) if coverage_row else None
        datasets = []
        for name in (
            "technical",
            "fundamentals",
            "financials",
            "analyst",
            "valuation",
            "options",
            "earnings",
        ):
            ref = _artifact(manifest, "research/" + name + ".json")
            clock = dataset_coverage.get(name) if dataset_coverage is not None else None
            if dataset_coverage is not None:
                clock = dict(clock or {"state": "missing"})
                if name != "financials" and clock.get("state") == "available":
                    last = clock.get("fetchedAt") or clock.get("lastSuccessfulAt")
                    try:
                        fetched = datetime.fromisoformat(last)
                        fetched = (
                            fetched.replace(tzinfo=UTC)
                            if fetched.tzinfo is None
                            else fetched.astimezone(UTC)
                        )
                        age = (datetime.now(UTC) - fetched).total_seconds() / 86400
                        if age > FRESHNESS_DAYS[name][1]:
                            clock.update(state="stale", reason="refresh-overdue")
                    except (ValueError, TypeError):
                        clock.update(state="stale", reason="refresh-time-unavailable")
                datasets.append(DatasetClock(dataset=name, **clock))
                continue
            if ref is None:
                datasets.append(DatasetClock(dataset=name))
                continue
            parser = {
                "technical": _technical_rows,
                "fundamentals": _fundamentals_rows,
                "financials": _financials_rows,
                "analyst": _analyst_rows,
                "valuation": _valuation_rows,
                "options": _option_rows,
                "earnings": _fundamentals_rows,
            }[name]
            if not _find(self._cached_rows(manifest, "research/" + name + ".json", parser), ticker):
                datasets.append(DatasetClock(dataset=name, reason="security-not-covered"))
                continue
            _, freshness = _freshness(ref, datetime.now(UTC))
            # A financial period does not go stale simply because no new filing
            # is due. Quote/options age and failed refreshes remain independent.
            state = "available" if name == "financials" or freshness != "stale" else "stale"
            datasets.append(
                DatasetClock(
                    dataset=name,
                    as_of=ref.data_as_of,
                    fetched_at=ref.generated_at.isoformat() if ref.generated_at else None,
                    last_successful_at=ref.generated_at.isoformat() if ref.generated_at else None,
                    state=state,
                    reason="; ".join(ref.warnings) or None,
                    version=ref.sha256,
                )
            )
        capabilities = []
        for task in (
            "overview",
            "fundamentals",
            "technical",
            "analyst",
            "valuation",
            "options",
            "ledger",
        ):
            inappropriate = is_fund and task in {"analyst", "valuation"}
            capabilities.append(
                ResearchCapability(
                    task=task,
                    state="notApplicable"
                    if inappropriate
                    else "available"
                    if any(
                        d.dataset == task and d.state in {"available", "stale"} for d in datasets
                    )
                    or task in {"overview", "ledger"}
                    else "missing",
                    reason="fund-research"
                    if inappropriate
                    else "financial-company-requires-equity-model"
                    if is_financial and task == "valuation"
                    else None,
                    intervals=["1d"] if task == "technical" else [],
                )
            )
        payload.context = ResearchContext(
            quote=make_quote(ticker, market or {}, fundamental),
            asset_type=asset_type,
            capabilities=capabilities,
            datasets=datasets,
        )
        if view in {"overview", "valuation", "fundamentals", "analyst", "ledger"} and not (
            view == "ledger" and detail in {"summary", "documents"}
        ):
            financial_row = (
                _find(
                    self._cached_rows(manifest, "research/financials.json", _financials_rows),
                    ticker,
                )
                or {}
            )
            raw = financial_row.get("financials") or {}
            # A different company joining the same artifact must not invalidate this
            # issuer's model inputs. Dataset clocks retain the container's SHA.
            row_version = fingerprint(raw)
            facts_key = (ticker, row_version, fingerprint(metrics))
            payload.financial_facts = self._facts_cache.get_or_compute(
                facts_key,
                lambda: build_financial_facts(
                    raw,
                    metrics,
                    source_version=row_version,
                    period_evidence=raw.get("periodEvidence"),
                ),
            )
            payload.research_evidence = raw.get("evidence") or {}

        if view == "technical" or (view == "overview" and detail != "summary"):
            payload.technical = _find(
                self._cached_rows(
                    manifest,
                    "research/technical.json",
                    _technical_rows,
                ),
                ticker,
            )
        if view == "valuation" or (view == "overview" and detail != "summary"):
            payload.valuation = _find(
                self._cached_rows(
                    manifest,
                    "research/valuation.json",
                    _valuation_rows,
                ),
                ticker,
            )
        if view == "options":
            payload.options = _find(
                self._cached_rows(
                    manifest,
                    "research/options.json",
                    _option_rows,
                    fallback_key="research/technical.json",
                ),
                ticker,
            )
            if payload.options:
                payload.options = dict(payload.options)
                payload.options["availability"] = chain_availability(
                    payload.options["capturedAt"], payload.options["expiries"]
                )
        if view == "fundamentals":
            # Reuse parsed immutable rows; enriching one ticker must not parse
            # every statement and every technical history again.
            payload.fundamentals = dict(fundamental)
            calendar = _normalized_earnings_calendar(
                _find(
                    self._cached_rows(manifest, "research/earnings.json", _fundamentals_rows),
                    ticker,
                )
            )
            if calendar is not None:
                payload.fundamentals["earningsCalendar"] = calendar
            technical = (
                _find(
                    self._cached_rows(manifest, "research/technical.json", _technical_rows), ticker
                )
                or {}
            )
            for key in ("seasonality", "seasonalityCoverage", "seasonalityMatrix", "yearPaths"):
                if key in technical:
                    payload.fundamentals[key] = technical[key]
            analyst = (
                _find(self._cached_rows(manifest, "research/analyst.json", _analyst_rows), ticker)
                or {}
            )
            history = (analyst.get("analyst") or {}).get("earningsHistory") or []
            payload.fundamentals["earningsHistory"] = [
                {
                    "date": str(h.get("quarter") or "")[:10],
                    "epsEstimate": h.get("epsEstimate"),
                    "epsReported": h.get("epsActual"),
                    "surprisePct": float(h["surprisePercent"]) * 100
                    if isinstance(h.get("surprisePercent"), int | float)
                    else None,
                }
                for h in history
                if isinstance(h, dict)
            ]
            financials_row = _find(
                self._cached_rows(
                    manifest,
                    "research/financials.json",
                    _financials_rows,
                ),
                ticker,
            )
            payload.financials = financials_row.get("financials") if financials_row else None
        if view in {"analyst", "fundamentals", "ledger"} and not (
            view == "ledger" and detail in {"summary", "documents"}
        ):
            analyst_row = _find(
                self._cached_rows(
                    manifest,
                    "research/analyst.json",
                    _analyst_rows,
                ),
                ticker,
            )
            payload.analyst = analyst_row.get("analyst") if analyst_row else None
            if payload.analyst:
                payload.analyst = {
                    **payload.analyst,
                    "providerRecommendationKey": metrics.get("recommendationKey"),
                    "providerRecommendationMean": metrics.get("recommendationMean"),
                    "providerRecommendationCount": metrics.get("numberOfAnalystOpinions"),
                }
        if view in {"overview", "ledger"} and not (
            view == "ledger" and detail in {"summary", "documents"}
        ):
            events = self.events(ticker, manifest)
            payload.latest_event = events[0] if events else None
            payload.portfolio_impact = self.portfolio_impact(ticker, manifest)
        if view == "ledger" and detail == "full":
            payload.timeline = self.timeline(ticker, limit=limit)
            payload.events = events
            payload.models = self.models(ticker, limit=limit)
            payload.alerts = self.alerts(ticker, manifest)
        # Fields are assigned conditionally above to keep the lens logic
        # readable. Re-validate once before returning so nested dictionaries
        # become their declared Pydantic models and response serialization can
        # never silently drift from the OpenAPI contract.
        # A legacy snapshot has no coverage index. Only claim a lens is usable
        # after its own security row has actually been loaded.
        if dataset_coverage is None:
            field = {
                "fundamentals": "financials",
                "technical": "technical",
                "analyst": "analyst",
                "valuation": "valuation",
                "options": "options",
            }.get(view)
            for capability in payload.context.capabilities:
                if capability.task == view and capability.state != "notApplicable" and field:
                    capability.state = "available" if getattr(payload, field, None) else "missing"
        if payload.technical and market:
            payload.technical = {**payload.technical, "currency": market.get("currency") or ""}
        if view == "ledger" and detail == "documents":
            financial_row = (
                _find(
                    self._cached_rows(manifest, "research/financials.json", _financials_rows),
                    ticker,
                )
                or {}
            )
            evidence = (financial_row.get("financials") or {}).get("evidence") or {}
            payload.research_evidence = {
                key: evidence.get(key)
                for key in ("filings", "news", "status", "asOf")
                if key in evidence
            }
        if view == "fundamentals" and detail == "summary":
            payload.financials = None
            payload.analyst = None
            for key in (
                "seasonality",
                "seasonalityCoverage",
                "seasonalityMatrix",
                "yearPaths",
                "earningsHistory",
            ):
                payload.fundamentals.pop(key, None)
        if view == "overview" and detail == "summary":
            payload.technical = None
            payload.valuation = None
            payload.fundamentals = dict(fundamental)
            payload.fundamentals["earningsCalendar"] = _normalized_earnings_calendar(
                _find(
                    self._cached_rows(manifest, "research/earnings.json", _fundamentals_rows),
                    ticker,
                )
            )
            payload.research_evidence = {
                "filings": list(payload.research_evidence.get("filings") or [])[:3]
            }
            facts = payload.financial_facts
            if facts:
                period = next((p for p in facts.periods if p.id == facts.latest_ttm), None)
                if period is None:
                    annual = sorted(
                        (p for p in facts.periods if p.kind == "annual"),
                        key=lambda p: p.provider_end,
                    )
                    period = annual[-1] if annual else None
                payload.financial_facts = facts.model_copy(
                    update={
                        "periods": [period] if period else [],
                        "observations": [
                            o
                            for o in facts.observations
                            if period
                            and o.period_id == period.id
                            and o.metric
                            in {"revenue", "operatingMargin", "netIncome", "freeCashflow"}
                        ],
                    }
                )
        if view == "technical" and detail != "full":
            if payload.technical:
                technical = dict(payload.technical)
                if detail == "seasonality":
                    payload.fundamentals = {
                        key: technical.get(key)
                        for key in (
                            "seasonality",
                            "seasonalityCoverage",
                            "seasonalityMatrix",
                            "yearPaths",
                        )
                    }
                for key in ("seasonality", "seasonalityCoverage", "seasonalityMatrix", "yearPaths"):
                    technical.pop(key, None)
                payload.technical = technical
            payload.fundamentals = {
                **(payload.fundamentals or {}),
                "earningsCalendar": _normalized_earnings_calendar(
                    _find(
                        self._cached_rows(manifest, "research/earnings.json", _fundamentals_rows),
                        ticker,
                    )
                ),
            }
        return ResearchLensSnapshot.model_validate(payload.__dict__)

    def timeline(
        self,
        ticker: str,
        *,
        limit: int = 30,
    ) -> list[ResearchTimelinePoint]:
        ticker = _canonical_ticker(ticker)
        points: list[ResearchTimelinePoint] = []
        seen: set[tuple[str | None, ...]] = set()
        for manifest in self._history_manifests():
            artifact_hashes = tuple(
                _artifact(manifest, key).sha256 if _artifact(manifest, key) else None
                for key in (
                    CURRENT_MARKET_KEY,
                    LEGACY_MARKET_KEY,
                    "research/technical.json",
                    "research/options.json",
                    "research/valuation.json",
                    "research/earnings.json",
                )
            )
            if artifact_hashes in seen:
                continue
            seen.add(artifact_hashes)
            # The timeline only renders technical, valuation and options
            # points. Building a full ticker snapshot here would also read
            # fundamentals, earnings, broker and look-through artifacts for
            # every historical run, which dominated the research page latency.
            market = _find(self._market_rows(manifest), ticker)
            technical = _find(
                self._cached_rows(manifest, "research/technical.json", _technical_rows),
                ticker,
            )
            valuation = _find(
                self._cached_rows(manifest, "research/valuation.json", _valuation_rows),
                ticker,
            )
            options = _find(
                self._cached_rows(
                    manifest,
                    "research/options.json",
                    _option_rows,
                    fallback_key="research/technical.json",
                ),
                ticker,
            )
            if not any((market, technical, valuation, options)):
                continue
            data_dates = [
                str(item.get("asOf"))
                for item in (
                    market,
                    technical,
                    valuation,
                )
                if item and item.get("asOf")
            ]
            points.append(
                ResearchTimelinePoint(
                    run_id=manifest.run_id,
                    generated_at=manifest.created_at,
                    data_as_of=max(data_dates) if data_dates else None,
                    technical=technical,
                    valuation=valuation,
                    options=options,
                )
            )
            if len(points) >= limit:
                break
        return points

    def models(
        self,
        ticker: str,
        *,
        limit: int = 20,
    ) -> list[ResearchModelRun]:
        ticker = _canonical_ticker(ticker)
        runs: list[ResearchModelRun] = []
        seen: set[str] = set()
        for manifest in self._history_manifests():
            artifact = _artifact(manifest, "research/valuation.json")
            if artifact is None or artifact.sha256 in seen:
                continue
            seen.add(artifact.sha256)
            valuation = _find(
                self._cached_rows(manifest, "research/valuation.json", _valuation_rows),
                ticker,
            )
            if valuation is None:
                continue
            runs.append(
                ResearchModelRun(
                    run_id=manifest.run_id,
                    generated_at=manifest.created_at,
                    data_as_of=artifact.data_as_of,
                    model_version=artifact.model_version,
                    ticker=ticker,
                    values=valuation,
                    dependency_hashes=artifact.dependency_hashes,
                )
            )
            if len(runs) >= limit:
                break
        numeric_keys = (
            "spot",
            "ev5",
            "ev10",
            "analystMedian",
            "impliedGrowth",
            "baseGrowth",
        )
        for index, run in enumerate(runs[:-1]):
            previous = runs[index + 1]
            changes: dict[str, float | str | None] = {}
            for key in numeric_keys:
                current_value = run.values.get(key)
                previous_value = previous.values.get(key)
                if isinstance(current_value, (int, float)) and isinstance(
                    previous_value, (int, float)
                ):
                    changes[key] = current_value - previous_value
            if run.values.get("verdict") != previous.values.get("verdict"):
                changes["verdict"] = (
                    f"{previous.values.get('verdict')} → {run.values.get('verdict')}"
                )
            run.changes = changes
        return runs

    def alerts(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> list[ResearchAlert]:
        ticker = _canonical_ticker(ticker)
        snapshot = self.ticker_snapshot(ticker, manifest)
        alerts: list[ResearchAlert] = []
        live_quote = (
            self.live_alerts.quote(ticker, snapshot_run_id=manifest.run_id)
            if self.live_alerts is not None
            else None
        )

        for artifact in self.status(manifest).artifacts:
            if artifact.kind not in {"market", "technical", "options", "valuation"}:
                continue
            if artifact.freshness != "stale":
                continue
            alerts.append(
                ResearchAlert(
                    alert_id=f"{ticker}:stale:{artifact.kind}",
                    ticker=ticker,
                    alert_type="freshness",
                    severity="critical" if artifact.kind in {"market", "options"} else "warning",
                    title=f"{artifact.kind.title()} data is stale",
                    message=(
                        f"The latest {artifact.kind} observation is "
                        f"{artifact.age_days:.0f} days old."
                    ),
                    as_of=artifact.data_as_of,
                )
            )

        score = (
            float(snapshot.technical.get("score"))
            if snapshot.technical and snapshot.technical.get("score") is not None
            else None
        )
        if score is not None and score <= 30:
            alerts.append(
                ResearchAlert(
                    alert_id=f"{ticker}:technical:weak",
                    ticker=ticker,
                    alert_type="technical",
                    severity="warning",
                    title="Technical structure is weak",
                    message=f"Technical score is {score:.0f}/100.",
                    as_of=str(snapshot.technical.get("asOf") or ""),
                )
            )
        elif score is not None and score >= 70:
            alerts.append(
                ResearchAlert(
                    alert_id=f"{ticker}:technical:strong",
                    ticker=ticker,
                    alert_type="technical",
                    severity="info",
                    title="Technical momentum is strong",
                    message=f"Technical score is {score:.0f}/100.",
                    as_of=str(snapshot.technical.get("asOf") or ""),
                )
            )

        valuation_is_validated = (
            snapshot.valuation is not None and snapshot.valuation.get("modelStatus") == "ready"
        )
        if valuation_is_validated and snapshot.valuation:
            ev10_upside = snapshot.valuation.get("ev10Upside")
            if isinstance(ev10_upside, (int, float)) and ev10_upside <= -0.15:
                alerts.append(
                    ResearchAlert(
                        alert_id=f"{ticker}:valuation:downside",
                        ticker=ticker,
                        alert_type="valuation",
                        severity="warning",
                        title="Valuation downside exceeds 15%",
                        message=f"EV10 indicates {ev10_upside:.1%} downside.",
                        as_of=str(snapshot.valuation.get("asOf") or ""),
                    )
                )
            elif isinstance(ev10_upside, (int, float)) and ev10_upside >= 0.25:
                alerts.append(
                    ResearchAlert(
                        alert_id=f"{ticker}:valuation:upside",
                        ticker=ticker,
                        alert_type="valuation",
                        severity="info",
                        title="Valuation margin exceeds 25%",
                        message=f"EV10 indicates {ev10_upside:.1%} upside.",
                        as_of=str(snapshot.valuation.get("asOf") or ""),
                    )
                )

        if valuation_is_validated and snapshot.valuation:
            value_range = snapshot.valuation.get("valueRange")
            spot = snapshot.valuation.get("spot")
            if isinstance(value_range, dict) and isinstance(spot, (int, float)) and spot > 0:
                bear = value_range.get("bear")
                bull = value_range.get("bull")
                if isinstance(bear, (int, float)) and spot < bear:
                    alerts.append(
                        ResearchAlert(
                            alert_id=f"{ticker}:valuation:below-bear",
                            ticker=ticker,
                            alert_type="valuation",
                            severity="warning",
                            title="Price below bear-case value",
                            message=(
                                f"Spot is {spot / bear - 1.0:.1%} below the "
                                "bear-case scenario value."
                            ),
                            as_of=str(snapshot.valuation.get("asOf") or ""),
                        )
                    )
                if isinstance(bull, (int, float)) and spot > bull:
                    alerts.append(
                        ResearchAlert(
                            alert_id=f"{ticker}:valuation:above-bull",
                            ticker=ticker,
                            alert_type="valuation",
                            severity="warning",
                            title="Price above bull-case value",
                            message=(
                                f"Spot is {spot / bull - 1.0:.1%} above the "
                                "bull-case scenario value."
                            ),
                            as_of=str(snapshot.valuation.get("asOf") or ""),
                        )
                    )

        impact = snapshot.portfolio_impact
        if impact.held and snapshot.technical:
            technical = snapshot.technical
            price = live_quote[0] if live_quote else technical.get("price")
            price_as_of = live_quote[1] if live_quote else technical.get("asOf")
            levels = (
                ("support20", "20D support", "support"),
                ("resistance20", "20D resistance", "resistance"),
            )
            if isinstance(price, (int, float)) and price > 0:
                for key, label, direction in levels:
                    level = technical.get(key)
                    if not isinstance(level, (int, float)) or level <= 0:
                        continue
                    distance = price / level - 1.0
                    if direction == "support" and price < level:
                        alerts.append(
                            ResearchAlert(
                                alert_id=f"{ticker}:position:support-breach",
                                ticker=ticker,
                                alert_type="position",
                                severity="critical",
                                title="Held position is below 20D support",
                                message=(
                                    f"{ticker} is at {price:.2f}, below the "
                                    f"20D support at {level:.2f}."
                                ),
                                as_of=str(price_as_of or ""),
                            )
                        )
                    elif abs(distance) <= 0.03:
                        alerts.append(
                            ResearchAlert(
                                alert_id=f"{ticker}:position:{direction}-near",
                                ticker=ticker,
                                alert_type="position",
                                severity="warning" if direction == "support" else "info",
                                title=f"Held position is near {label}",
                                message=(
                                    f"{ticker} is {abs(distance):.1%} from the "
                                    f"{label.lower()} at {level:.2f}."
                                ),
                                as_of=str(price_as_of or ""),
                            )
                        )
                sma200 = technical.get("sma200")
                if isinstance(sma200, (int, float)) and price < sma200:
                    alerts.append(
                        ResearchAlert(
                            alert_id=f"{ticker}:position:below-sma200",
                            ticker=ticker,
                            alert_type="position",
                            severity="warning",
                            title="Held position is below SMA 200",
                            message=(f"{ticker} is at {price:.2f}; SMA 200 is {sma200:.2f}."),
                            as_of=str(price_as_of or ""),
                        )
                    )
        if impact.allocation_pct >= 0.10:
            alerts.append(
                ResearchAlert(
                    alert_id=f"{ticker}:portfolio:concentration",
                    ticker=ticker,
                    alert_type="portfolio",
                    severity="warning",
                    title="Single-name exposure exceeds 10%",
                    message=(
                        f"Look-through exposure is {impact.allocation_pct:.1%} of the portfolio."
                    ),
                    as_of=str(manifest.created_at.date()),
                )
            )

        if snapshot.options:
            spot = live_quote[0] if live_quote else snapshot.options.get("spot")
            for name, label in (("callWall", "call wall"), ("putWall", "put wall")):
                level = snapshot.options.get(name)
                if (
                    not isinstance(spot, (int, float))
                    or not isinstance(level, (int, float))
                    or not spot
                ):
                    continue
                distance = abs(level / spot - 1.0)
                if distance <= 0.03:
                    alerts.append(
                        ResearchAlert(
                            alert_id=f"{ticker}:options:{name}",
                            ticker=ticker,
                            alert_type="options",
                            severity="warning",
                            title=f"Spot is near the {label}",
                            message=(
                                f"Spot {spot:.2f} is {distance:.1%} from "
                                f"the {label} at {level:.2f}."
                            ),
                            as_of=str(
                                live_quote[1]
                                if live_quote
                                else snapshot.options.get("capturedAt") or ""
                            ),
                        )
                    )
        return alerts

    def overview(
        self,
        manifest: SnapshotManifest,
        *,
        ticker: str | None = None,
        limit: int = 20,
    ) -> ResearchOverview:
        instruments = self.instruments(manifest)
        fundamentals = _enrich_fundamentals(
            _fundamentals_rows(self._read_optional(manifest, "research/fundamentals.json")),
            self._read_optional(manifest, "research/earnings.json"),
            self._read_optional(manifest, "research/technical.json"),
            self._read_optional(manifest, "research/analyst.json"),
        )
        requested_ticker = _canonical_ticker(ticker) if ticker else None
        selected_ticker = (
            requested_ticker
            if requested_ticker and any(item.ticker == requested_ticker for item in instruments)
            else next(
                (item.ticker for item in instruments if item.held),
                instruments[0].ticker if instruments else None,
            )
        )
        if selected_ticker is None:
            return ResearchOverview(
                status=self.status(manifest),
                watchlist_categories=self.watchlist.categories(),
                instruments=instruments,
                fundamentals=fundamentals,
            )
        return ResearchOverview(
            status=self.status(manifest),
            watchlist_categories=self.watchlist.categories(),
            instruments=instruments,
            fundamentals=fundamentals,
            selected=self.ticker_snapshot(selected_ticker, manifest),
            timeline=self.timeline(selected_ticker, limit=limit),
            events=self.events(selected_ticker, manifest),
            models=self.models(selected_ticker, limit=limit),
            alerts=self.alerts(selected_ticker, manifest),
        )

    def price_series(
        self,
        ticker: str,
        manifest: SnapshotManifest,
        *,
        limit: int = 504,
    ) -> ResearchPriceSeries:
        ticker = self._route_ticker(ticker)
        artifact = _artifact(manifest, "research/technical.json")
        metadata_artifact = _artifact(manifest, "research/fundamentals.json")
        marker_artifact = _artifact(manifest, "account/trade_markers.json")
        cache_key = (
            (artifact.sha256 + ":" + metadata_artifact.sha256)
            if artifact is not None and metadata_artifact is not None
            else manifest.run_id,
            marker_artifact.sha256 if marker_artifact is not None else "",
            ticker,
        )
        cached = self._price_series_cache.get(cache_key)
        if cached is not None:
            as_of, currency, all_points, all_markers = cached
            points = all_points[-limit:]
            visible_dates = {point.date for point in points}
            return ResearchPriceSeries(
                ticker=ticker,
                as_of=as_of,
                currency=currency,
                available_sessions=len(all_points),
                points=points,
                trade_markers=[marker for marker in all_markers if marker.date in visible_dates],
                events=[
                    {"date": p.date, "kind": kind, "value": value, "currency": currency}
                    for p in points
                    for kind, value in (("dividend", p.dividend), ("split", p.split))
                    if value
                ],
            )
        raw = self._raw_price_cache.get_or_compute(
            artifact.sha256 if artifact else manifest.run_id,
            lambda: self._read_optional(manifest, "research/technical.json"),
        )
        raw_rows = raw.get("rows")
        rows = raw_rows if isinstance(raw_rows, list) else []
        source = _find([row for row in rows if isinstance(row, dict)], ticker)
        if source is None:
            raise FileNotFoundError(f"technical research not found for {ticker}")
        raw_points = source.get("price_series")
        all_points = [
            PriceSeriesPoint.model_validate(point)
            for point in (raw_points if isinstance(raw_points, list) else [])
            if isinstance(point, dict)
        ]
        as_of = str(source.get("as_of") or raw.get("as_of") or "")
        market = _find(self._market_rows(manifest), ticker) or {}
        currency = str(market.get("currency") or source.get("currency") or "")
        raw_markers = (
            self._read_optional(manifest, "account/trade_markers.json")
            if marker_artifact is not None
            else {}
        )
        marker_rows = raw_markers.get("rows")
        all_markers = [
            ResearchTradeMarker.model_validate(marker)
            for marker in (marker_rows if isinstance(marker_rows, list) else [])
            if isinstance(marker, dict)
            and _canonical_ticker(str(marker.get("ticker") or "")) == _canonical_ticker(ticker)
        ]
        if len(self._price_series_cache) >= 128:
            self._price_series_cache.clear()
        self._price_series_cache[cache_key] = (
            as_of,
            currency,
            all_points,
            all_markers,
        )
        points = all_points[-limit:]
        visible_dates = {point.date for point in points}
        return ResearchPriceSeries(
            ticker=ticker,
            as_of=as_of,
            currency=currency,
            available_sessions=len(all_points),
            points=points,
            trade_markers=[marker for marker in all_markers if marker.date in visible_dates],
            events=[
                {"date": p.date, "kind": kind, "value": value, "currency": currency}
                for p in points
                for kind, value in (("dividend", p.dividend), ("split", p.split))
                if value
            ],
        )
