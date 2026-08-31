"""Build ticker research projections from validated immutable artifacts."""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from .artifacts import ArtifactStore
from .dashboard import _option_rows, _technical_rows, _valuation_rows
from .dashboard_models import (
    PriceSeriesPoint,
    ResearchDirectoryInstrument,
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchPriceSeries,
    ResearchShell,
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
                "currency": str(row.get("currency") or "USD"),
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
            "currency": str(row.get("ccy") or "USD"),
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


def _find(rows: list[JsonObject], ticker: str) -> JsonObject | None:
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
        self._row_cache: dict[tuple[str, str], list[JsonObject]] = {}
        self._price_series_cache: dict[
            tuple[str, str],
            tuple[str, str, list[PriceSeriesPoint]],
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
            if cache_key is not None and cache_key in self._row_cache:
                cached = self._row_cache[cache_key]
            else:
                cached = parser(self._read_optional(manifest, candidate))
                if cache_key is not None:
                    if len(self._row_cache) >= 256:
                        self._row_cache.clear()
                    self._row_cache[cache_key] = cached
            if cached:
                return cached
        return []

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
        for artifact in manifest.artifacts:
            if not artifact.key.startswith("research/"):
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
        market_raw = self._read_optional(manifest, "research/daily_market.json")
        if not market_raw:
            market_raw = self._read_optional(manifest, "research/market_snapshot.json")
        market = _market_rows(market_raw)
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

        held = {
            _canonical_ticker(str(position.get("ticker", "")))
            for account in broker.get("accounts", {}).values()
            for position in account.get("positions", [])
        }
        exposure = {
            _canonical_ticker(str(position.get("ticker", ""))): float(
                position.get("valueGbp") or 0.0
            )
            for position in lookthrough.get("positions", [])
            if position.get("ticker")
        }
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
                    (fundamental_by_ticker.get(item.ticker, {}).get("metrics") or {}).get("website")
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
                    if item.ticker in market_tickers and item.ticker in technical_tickers
                    else "partial"
                    if item.ticker
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
                has_market=item.ticker in market_tickers,
                has_technical=item.ticker in technical_tickers,
                has_options=item.ticker in option_tickers,
                has_valuation=item.ticker in valuation_tickers,
                has_earnings=item.ticker in earnings_tickers,
                has_fundamentals=item.ticker in fundamentals_tickers,
                held=item.ticker in held,
                exposure_gbp=exposure.get(item.ticker, 0.0),
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
            etf_contributors=list(position.get("etfContributors") or []),
        )

    def ticker_snapshot(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> ResearchTickerSnapshot:
        ticker = _canonical_ticker(ticker)
        market = _find(
            self._cached_rows(
                manifest,
                "research/daily_market.json",
                _market_rows,
                fallback_key="research/market_snapshot.json",
            ),
            ticker,
        )
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
            technical=technical,
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
        held = {
            _canonical_ticker(str(position.get("ticker", "")))
            for account in broker.get("accounts", {}).values()
            for position in account.get("positions", [])
        }
        exposure = {
            _canonical_ticker(str(position.get("ticker", ""))): float(
                position.get("valueGbp") or 0.0
            )
            for position in lookthrough.get("positions", [])
            if position.get("ticker")
        }
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
                held=item.ticker in held,
                exposure_gbp=exposure.get(item.ticker, 0.0),
            )
            for item in self.watchlist.items()
        ]

    def lens_snapshot(
        self,
        ticker: str,
        view: ResearchLensName,
        manifest: SnapshotManifest,
        *,
        limit: int = 30,
    ) -> ResearchLensSnapshot:
        """Build one independently loadable research lens.

        The legacy ticker snapshot remains available for API compatibility, but
        the web workbench uses this scoped response so opening valuation never
        parses financial statements, options, timeline history, or unrelated
        portfolio data.
        """

        ticker = _canonical_ticker(ticker)
        market = _find(
            self._cached_rows(
                manifest,
                "research/daily_market.json",
                _market_rows,
                fallback_key="research/market_snapshot.json",
            ),
            ticker,
        )
        payload = ResearchLensSnapshot(
            ticker=ticker,
            view=view,
            run_id=manifest.run_id,
            generated_at=manifest.created_at.isoformat(),
            market=market,
        )

        if view in {"overview", "technical"}:
            payload.technical = _find(
                self._cached_rows(
                    manifest,
                    "research/technical.json",
                    _technical_rows,
                ),
                ticker,
            )
        if view in {"overview", "valuation"}:
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
        if view == "fundamentals":
            payload.fundamentals = _find(
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
            financials_row = _find(
                self._cached_rows(
                    manifest,
                    "research/financials.json",
                    _financials_rows,
                ),
                ticker,
            )
            payload.financials = financials_row.get("financials") if financials_row else None
        if view == "analyst":
            analyst_row = _find(
                self._cached_rows(
                    manifest,
                    "research/analyst.json",
                    _analyst_rows,
                ),
                ticker,
            )
            payload.analyst = analyst_row.get("analyst") if analyst_row else None
        if view in {"overview", "ledger"}:
            events = self.events(ticker, manifest)
            payload.latest_event = events[0] if events else None
            payload.portfolio_impact = self.portfolio_impact(ticker, manifest)
        if view == "ledger":
            payload.timeline = self.timeline(ticker, limit=limit)
            payload.events = events
            payload.models = self.models(ticker, limit=limit)
            payload.alerts = self.alerts(ticker, manifest)
        # Fields are assigned conditionally above to keep the lens logic
        # readable. Re-validate once before returning so nested dictionaries
        # become their declared Pydantic models and response serialization can
        # never silently drift from the OpenAPI contract.
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
                    "research/daily_market.json",
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
            market = _find(
                self._cached_rows(
                    manifest,
                    "research/daily_market.json",
                    _market_rows,
                    fallback_key="research/market_snapshot.json",
                ),
                ticker,
            )
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
        ticker = _canonical_ticker(ticker)
        artifact = _artifact(manifest, "research/technical.json")
        cache_key = (
            artifact.sha256 if artifact is not None else manifest.run_id,
            ticker,
        )
        cached = self._price_series_cache.get(cache_key)
        if cached is not None:
            as_of, currency, all_points = cached
            return ResearchPriceSeries(
                ticker=ticker,
                as_of=as_of,
                currency=currency,
                available_sessions=len(all_points),
                points=all_points[-limit:],
            )
        raw = self._read_optional(manifest, "research/technical.json")
        raw_rows = raw.get("rows")
        rows = raw_rows if isinstance(raw_rows, list) else []
        source = next(
            (
                row
                for row in rows
                if isinstance(row, dict)
                and _canonical_ticker(str(row.get("ticker") or "")) == ticker
            ),
            None,
        )
        if source is None:
            raise FileNotFoundError(f"technical research not found for {ticker}")
        raw_points = source.get("price_series")
        all_points = [
            PriceSeriesPoint.model_validate(point)
            for point in (raw_points if isinstance(raw_points, list) else [])
            if isinstance(point, dict)
        ]
        as_of = str(source.get("as_of") or raw.get("as_of") or "")
        currency = str(source.get("currency") or "USD")
        if len(self._price_series_cache) >= 128:
            self._price_series_cache.clear()
        self._price_series_cache[cache_key] = (as_of, currency, all_points)
        return ResearchPriceSeries(
            ticker=ticker,
            as_of=as_of,
            currency=currency,
            available_sessions=len(all_points),
            points=all_points[-limit:],
        )
