"""Build ticker research projections from validated immutable artifacts."""

from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, date, datetime
from functools import partial
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import ValidationError
from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY, ETFReading
from trading_max.infrastructure.alpaca_market_prices import ALPACA_SIP
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.reference import CatalogSecurityMaster, SecurityMasterCatalog
from trading_max.reference.quote_units import major_quote_unit
from trading_max.research.calendar import session_schedule
from trading_max.research.facts import (
    DatasetClock,
    ResearchCapability,
    ResearchContext,
    build_financial_facts,
    fingerprint,
    make_quote,
    number,
)
from trading_max.research.fund_references import fund_peers, us_fund, us_fund_listing
from trading_max.research.held_funds import (
    FUND_PRICE_DIRECTORY_KEY,
    FUND_PRICES_KEY,
    SECURITY_MASTER_KEY,
    FundListingIdentity,
    held_fund_positions,
    observed_product,
)
from trading_max.research.listing import broker_listing
from trading_max.research.option_terms import chain_availability
from trading_max.research.trailing_pe import TrailingPeHistory
from trading_max.research.venues import (
    VenueClaim,
    VenueConflict,
    provider_claim,
    resolve_venue,
    row_claims,
    watchlist_claim,
)

from .artifacts import ArtifactStore
from .dashboard_models import (
    OptionSnapshot,
    PriceSeriesPoint,
    ResearchDirectoryInstrument,
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchPriceSeries,
    ResearchShell,
    ResearchTradeMarker,
    TechnicalScoreSummary,
)
from .etf_snapshot import find_etf, read_etf_portfolio
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
from .projections.broker import overlay_live_broker_snapshot
from .projections.research import option_rows, valuation_rows
from .projections.research import technical_rows as project_technical_rows
from .projections.trade_markers import broker_symbol, chart_trade_markers
from .research_listing import PinnedListing, exact_row
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
BROKER_KEY = "account/broker_snapshot_metrics.json"
LIVE_BROKER_KEY = "account/intraday/broker_values.json"
LOOKTHROUGH_KEY = "account/lookthrough_metrics.json"


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


def _market_rows(raw: JsonObject, *, with_claims=False) -> list[JsonObject]:
    typed_technical = raw.get("technical")
    if isinstance(typed_technical, dict):
        return [
            {
                "ticker": str(row.get("ticker") or ""),
                "currency": str(row.get("currency") or ""),
                "spot": row.get("price"),
                **({"_venue_claims": row_claims(row.get("ticker"), row)} if with_claims else {}),
                "held": False,
                "asOf": row.get("as_of") or raw.get("as_of"),
            }
            for row in typed_technical.get("rows", [])
            if isinstance(row, dict)
        ]
    return [
        {
            "ticker": str(row.get("t")),
            **({"_venue_claims": row_claims(row.get("t"), row)} if with_claims else {}),
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


_market_rows_with_claims = partial(_market_rows, with_claims=True)


def _raw_options(raw):
    embedded = raw.get("options")
    rows = embedded.values() if isinstance(embedded, dict) else raw.get("rows") or []
    return [row for row in rows if isinstance(row, dict) and {"spot", "expiry_count"} & row.keys()]


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


def _technical_summary(row: JsonObject | None) -> TechnicalScoreSummary | None:
    if row is None:
        return None
    return TechnicalScoreSummary.model_validate(row)


_TECHNICAL_SEASONALITY = ("seasonality", "seasonalityCoverage", "seasonalityMatrix", "yearPaths")


def published_price_series_id(artifact_hash: str, ticker: str) -> str:
    return fingerprint([artifact_hash, ticker.upper()])


def _visible_price_sessions(series: ResearchPriceSeries, limit: int) -> ResearchPriceSeries:
    points = series.points[-limit:]
    dates = {point.date for point in points}
    return series.model_copy(
        update={
            "points": points,
            "trade_markers": [m for m in series.trade_markers if m.date in dates],
            "events": [e for e in series.events if e["date"] in dates],
        }
    )


def _canonical_ticker(value: str) -> str:
    ticker = value.upper()
    return ticker[:-2] if ticker.endswith(".L") else ticker


def _quote_unit_price(value: Any, currency: Any) -> tuple[float | None, str | None]:
    """Report pence prices in pounds, as research quotes do."""

    price = number(value)
    code = str(currency or "") or None
    if price is None or price <= 0:
        return None, code
    code, divisor = major_quote_unit(code or "")
    return price / divisor, code or None


def _account_holdings(broker: JsonObject, lookthrough: JsonObject) -> dict[str, JsonObject]:
    """Direct and fund exposure per security on the current broker basis.

    Direct values and prices come from the broker snapshot the holdings page
    shows. Look-through runs less often, so each fund contribution is revalued
    by that fund's current broker value relative to its value at look-through
    time; a fund that is no longer held contributes nothing.

    A security has a broker price and listing only when one broker line holds
    it. Lines on several listings (another market, or a ``.L`` alias the
    ticker key collapses) leave neither, so no price stands for another listing.
    """

    holdings: dict[str, JsonObject] = {}

    def entry(key: str) -> JsonObject:
        return holdings.setdefault(
            key,
            {
                "held": False,
                "direct": 0.0,
                "indirect": 0.0,
                "price": None,
                "currency": None,
                "asOf": None,
                "listing": None,
                "lines": {},
                "accounts": [],
                "contributors": [],
            },
        )

    accounts = broker.get("accounts")
    for code, account in accounts.items() if isinstance(accounts, dict) else ():
        if not isinstance(account, dict):
            continue
        # Prices come from the positions, which can be older than the account totals.
        as_of = (
            str(
                account.get("positions_observed_at")
                or account.get("fetched_at")
                or account.get("fetched_at_utc")
                or ""
            )
            or None
        )
        for position in account.get("positions") or []:
            if not isinstance(position, dict):
                continue
            key = _canonical_ticker(str(position.get("ticker") or ""))
            if not key:
                continue
            item = entry(key)
            value = number(position.get("current_value_gbp")) or 0.0
            item["held"] = True
            item["direct"] += value
            if value > 0 and str(code) not in item["accounts"]:
                item["accounts"].append(str(code))
            # The same instrument in two accounts is one line; its latest
            # observation is the price.
            instrument = str(position.get("broker_ticker") or "")
            line = item["lines"].setdefault(
                instrument or str(position.get("isin") or "") or key,
                {
                    "listing": broker_listing(instrument),
                    "price": None,
                    "currency": None,
                    "asOf": None,
                },
            )
            price, currency = _quote_unit_price(
                position.get("current_price"), position.get("price_currency")
            )
            if price is not None and (line["asOf"] is None or (as_of or "") >= line["asOf"]):
                line.update(price=price, currency=currency, asOf=as_of)
    for item in holdings.values():
        if len(item["lines"]) == 1:
            item.update(next(iter(item["lines"].values())))

    fund_values: dict[str, float] = {}
    for source in lookthrough.get("sources") or []:
        value = number(source.get("positionValueGbp")) if isinstance(source, dict) else None
        if value is not None and value > 0:
            fund_values[_canonical_ticker(str(source.get("ticker") or ""))] = value
    current_funds = {key: item["direct"] for key, item in holdings.items()}
    for position in lookthrough.get("positions") or []:
        if not isinstance(position, dict):
            continue
        key = _canonical_ticker(str(position.get("ticker") or ""))
        if not key:
            continue
        contributors = []
        for contributor in position.get("etfContributors") or []:
            if not isinstance(contributor, dict):
                continue
            fund = _canonical_ticker(str(contributor.get("ticker") or ""))
            value = number(contributor.get("valueGbp")) or 0.0
            then = fund_values.get(fund)
            if then:
                value = value * current_funds.get(fund, 0.0) / then
            contributors.append({**contributor, "valueGbp": round(value, 2)})
        if contributors:
            indirect = sum(item["valueGbp"] for item in contributors)
        elif "indirectValueGbp" in position:
            indirect = number(position.get("indirectValueGbp")) or 0.0
        else:
            # Rows without a direct/fund split predate schema 5.
            indirect = max(
                (number(position.get("valueGbp")) or 0.0)
                - (number(position.get("directValueGbp")) or 0.0),
                0.0,
            )
        item = entry(key)
        item["indirect"] += indirect
        item["contributors"].extend(contributors)
    return holdings


def _position_fields(holdings: dict[str, JsonObject], ticker: str) -> JsonObject:
    """Directory fields for one security; fund units keep their direct value."""

    item = holdings.get(_canonical_ticker(ticker))
    if item is None:
        return {"held": False, "exposure_gbp": 0.0}
    held = bool(item["held"])
    return {
        "held": held,
        "exposure_gbp": round(item["direct"] + item["indirect"], 2),
        "direct_value_gbp": round(item["direct"], 2),
        "broker_price": item["price"] if held else None,
        "broker_price_currency": item["currency"] if held else None,
        "broker_as_of": item["asOf"] if held else None,
        "broker_listing": item["listing"] if held else None,
    }


def _exchange_today(metrics: JsonObject | None, now: datetime | None = None) -> date:
    """The exchange's current calendar date.

    A report dated today is not past until its market's day ends: at 00:01 UTC
    New York is still on the previous evening.
    """

    current = now or datetime.now(UTC)
    zone = str((metrics or {}).get("exchangeTimezoneName") or "")
    if zone:
        try:
            return current.astimezone(ZoneInfo(zone)).date()
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return current.astimezone(UTC).date()


def _next_earnings_date(
    analyst: JsonObject | None,
    calendar: JsonObject | None,
    today: date,
) -> str | None:
    """The one next report date: provider events first, then the calendar; never past.

    Report dates are exchange calendar dates, so `today` must be the exchange's
    date too (see `_exchange_today`).
    """

    upcoming = [
        day
        for row in (analyst or {}).get("earningsEvents") or []
        if isinstance(row, dict) and str(row.get("status") or "") != "reported"
        if (day := _parse_date(str(row.get("date") or ""))) is not None and day >= today
    ]
    if not upcoming:
        upcoming = [
            day
            for value in (calendar or {}).get("earningsDates") or []
            if (day := _parse_date(str(value))) is not None and day >= today
        ]
    return min(upcoming).isoformat() if upcoming else None


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


def _normalized_earnings_calendar(
    row: JsonObject | None, today: date | None = None
) -> JsonObject | None:
    """Provider calendar with past windows dropped; `today` is the exchange's date."""
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
    # A provider calendar can keep a report that has already happened; a past
    # window is not the next one.
    current = today or datetime.now(UTC).date()
    if calendar.get("earningsDates") and not any(
        (day := _parse_date(value)) is not None and day >= current
        for value in calendar["earningsDates"]
    ):
        calendar["earningsDates"] = []
    return calendar


def _enrich_fundamentals(
    fundamentals: list[JsonObject],
    earnings_raw: JsonObject,
    technical_raw: JsonObject,
    analyst_raw: JsonObject | None,
    pin_listing: Callable[[str], PinnedListing],
) -> list[JsonObject]:
    earnings_rows = [dict(row) for row in earnings_raw.get("rows", []) if isinstance(row, dict)]
    technical_rows = project_technical_rows(technical_raw)
    analyst_rows = _analyst_rows(analyst_raw) if analyst_raw else []
    enriched: list[JsonObject] = []
    for row in fundamentals:
        ticker = str(row.get("ticker") or "")
        pinned = pin_listing(ticker)
        if ticker not in (pinned.symbol, pinned.ticker) or pinned.venue().conflict:
            continue
        item = dict(row)
        calendar = _normalized_earnings_calendar(
            pinned.event_row(exact_row(earnings_rows, ticker))[0],
            _exchange_today(row.get("metrics")),
        )
        if calendar is not None:
            item["earningsCalendar"] = calendar
        technical = exact_row(technical_rows, pinned.ticker)
        if technical is not None:
            item["seasonality"] = list(technical.get("seasonality") or [])
            item["seasonalityCoverage"] = dict(technical.get("seasonalityCoverage") or {})
            item["seasonalityMatrix"] = list(technical.get("seasonalityMatrix") or [])
            item["yearPaths"] = dict(technical.get("yearPaths") or {})
            # Reported-versus-estimate history lives in the analyst artifact; the
            # earnings calendar only carries the upcoming event, which left the
            # fundamentals earnings card with a date and nothing else.
        analyst_row = pinned.event_row(exact_row(analyst_rows, ticker))[0]
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
        self._fund_cache: SingleFlightCache[str, dict[FundListingIdentity, dict[str, dict]]] = (
            SingleFlightCache(8)
        )
        self._facts_cache: SingleFlightCache[tuple, Any] = SingleFlightCache(128)
        self._row_cache: SingleFlightCache[tuple, list[JsonObject]] = SingleFlightCache(256)
        self._raw_price_cache: SingleFlightCache[str, JsonObject] = SingleFlightCache(2)
        self._price_series_cache: dict[tuple[str, ...], ResearchPriceSeries] = {}
        self._history_lock = threading.RLock()
        self._history_signature: tuple[str | None, ...] | None = None
        self._history_manifests_cache: list[SnapshotManifest] = []

    def _history_manifests(self) -> list[SnapshotManifest]:
        """Reuse research history while intraday-only snapshots are published."""

        latest = self.store.latest_manifest()
        if latest is None:
            return []
        keys = (
            FUND_PRICE_DIRECTORY_KEY,
            FUND_PRICES_KEY,
            SECURITY_MASTER_KEY,
            "research/fundamentals.json",
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
            cache_key = (artifact.sha256, candidate, parser) if artifact is not None else None
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
            _market_rows_with_claims,
            fallback_key=LEGACY_MARKET_KEY,
        )
        # Compact quote metadata lives in fundamentals. Older technical batches
        # defaulted to USD; the provider's explicit quote currency takes precedence.
        # Do not load financial statements, options or the full research bundle.
        fundamentals = self._cached_rows(manifest, "research/fundamentals.json", _fundamentals_rows)
        enriched = []
        for row in rows:
            fundamental = next(
                (f for f in fundamentals if f.get("ticker") == row.get("ticker")), {}
            )
            metrics = fundamental.get("metrics") or fundamental.get("info") or {}
            quote_currency = str(fundamental.get("currency") or metrics.get("currency") or "")
            quote_currency, quote_divisor = major_quote_unit(quote_currency)
            enriched.append(
                {
                    **{key: value for key, value in row.items() if key != "_venue_claims"},
                    "currency": quote_currency or row.get("currency") or "",
                    **{
                        target: (
                            metrics[source] / quote_divisor
                            if target == "analystMedian" and quote_divisor != 1
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

    def _route_ticker(
        self, ticker: str, exchanges: dict[str, tuple[VenueClaim, ...]] | None = None
    ) -> str:
        """Keep exchange-qualified watchlist identities in links and responses."""
        ticker = ticker.strip().upper()
        if us_fund(ticker):
            return ticker
        if exchanges is None:
            exchanges = self.watchlist.listing_exchanges()
        if ticker in exchanges:
            return ticker
        matches = [
            symbol
            for symbol in exchanges
            if _canonical_ticker(symbol) == _canonical_ticker(ticker)
            and not resolve_venue(ticker, VenueClaim("symbol", symbol), *exchanges[symbol]).conflict
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
        technical = project_technical_rows(self._read_optional(manifest, "research/technical.json"))
        valuations = valuation_rows(self._read_optional(manifest, "research/valuation.json"))
        options_raw = self._read_optional(manifest, "research/options.json")
        if not options_raw:
            options_raw = self._read_optional(manifest, "research/technical.json")
        options = option_rows(options_raw)
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
        holdings = self._holdings(manifest)
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
                **_position_fields(holdings, item.ticker),
            )
            for item in self.watchlist.items()
        ]

    def events(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> list[ResearchEvent]:
        pinned = self.pin_listing(ticker, manifest)
        ticker = pinned.symbol
        if pinned.venue().conflict:
            return []
        raw = self._read_optional(manifest, "research/earnings.json")
        companies = raw.get("companies", {})
        if not companies and isinstance(raw.get("rows"), list):
            company = next(
                (
                    row
                    for row in raw["rows"]
                    if isinstance(row, dict) and str(row.get("ticker") or "").upper() == ticker
                ),
                None,
            )
            company, _ = pinned.event_row(company)
            if company:
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
        company, _ = pinned.event_row(company) if isinstance(company, dict) else ({}, False)
        if not company:
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
        broker = self._broker_snapshot(manifest)
        accounts = [
            account
            for account in (broker.get("accounts") or {}).values()
            if isinstance(account, dict)
        ]
        total_value = sum(float(account.get("total_value_gbp") or 0.0) for account in accounts)
        lookthrough = self._read_optional(manifest, LOOKTHROUGH_KEY)
        holding = _account_holdings(broker, lookthrough).get(ticker) or {}
        # Country and industry come from look-through; values from the broker basis.
        position = next(
            (
                item
                for item in lookthrough.get("positions", [])
                if _canonical_ticker(str(item.get("ticker", ""))) == ticker
            ),
            {},
        )
        direct = round(float(holding.get("direct") or 0.0), 2)
        indirect = round(float(holding.get("indirect") or 0.0), 2)
        exposure = round(direct + indirect, 2)
        holding_accounts = list(holding.get("accounts") or [])
        fund_sources = {str(s.get("ticker", "")): s for s in lookthrough.get("sources", [])}
        contributors = [
            {
                **item,
                "asOf": fund_sources.get(str(item.get("ticker", "")), {}).get("asOf"),
                "sourceUrl": fund_sources.get(str(item.get("ticker", "")), {}).get("sourceUrl"),
            }
            for item in holding.get("contributors") or []
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
            as_of=max(
                (
                    str(account.get("positions_observed_at") or account.get("fetched_at") or "")
                    for account in accounts
                ),
                default="",
            )
            or None,
        )

    def ticker_snapshot(
        self,
        ticker: str,
        manifest: SnapshotManifest,
    ) -> ResearchTickerSnapshot:
        pinned = self.pin_listing(ticker, manifest)
        ticker = pinned.symbol
        if pinned.venue().conflict:
            return ResearchTickerSnapshot(
                ticker=ticker,
                run_id=manifest.run_id,
                generated_at=manifest.created_at,
                portfolio_impact=self.portfolio_impact(ticker, manifest),
            )
        if listing := pinned.held:
            lens = self._fund_lens(pinned, "technical", manifest, detail="full")
            return ResearchTickerSnapshot(
                ticker=listing.ticker,
                run_id=manifest.run_id,
                generated_at=manifest.created_at,
                market=lens.market,
                technical=lens.technical.model_dump() if lens.technical else None,
                fundamentals={"metrics": {"quoteType": lens.context.asset_type}},
                portfolio_impact=self.portfolio_impact(listing.ticker, manifest),
            )
        market = exact_row(self._market_rows(manifest), ticker)
        technical = exact_row(
            self._cached_rows(manifest, "research/technical.json", project_technical_rows),
            pinned.ticker,
        )
        valuation = exact_row(
            self._cached_rows(manifest, "research/valuation.json", valuation_rows),
            ticker,
        )
        options = self._option_chain(manifest, ticker, pinned=pinned)
        lens = self.lens_snapshot(ticker, "fundamentals", manifest)
        fundamentals = lens.fundamentals
        analyst = pinned.event_row(
            exact_row(self._cached_rows(manifest, "research/analyst.json", _analyst_rows), ticker)
        )[0].get("analyst")
        financials = lens.financials
        events = self.events(ticker, manifest)
        return ResearchTickerSnapshot(
            ticker=ticker,
            run_id=manifest.run_id,
            generated_at=manifest.created_at,
            market=market,
            technical=(
                {**technical, "currency": technical.get("currency") or market.get("currency") or ""}
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

        holdings = self._holdings(manifest)
        etfs = self._published_etfs(manifest)
        held_funds = self._held_funds(manifest)
        price_directory = (
            self._cached_rows(manifest, FUND_PRICE_DIRECTORY_KEY, _fundamentals_rows)
            if _artifact(manifest, FUND_PRICE_DIRECTORY_KEY)
            else []
        )

        def saved_fund_isin(ticker: str) -> str | None:
            if us_fund(ticker):
                return None
            reading = find_etf(etfs, ticker)
            if reading:
                return reading.isin
            return next(
                (row.get("isin") for row in price_directory if row.get("ticker") == ticker),
                None,
            )

        listed = [
            ResearchDirectoryInstrument(
                is_fund=us_fund(item.ticker) is not None
                or find_etf(etfs, item.ticker) is not None
                or any(row.get("ticker") == item.ticker for row in price_directory),
                fund_isin=saved_fund_isin(item.ticker),
                us_fund_peers=list(fund_peers(saved_fund_isin(item.ticker))),
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
                **(_position_fields(holdings, item.ticker) if not us_fund(item.ticker) else {}),
            )
            for item in self.watchlist.items()
        ]
        for listing, accounts in held_funds.items():
            saved = next((i for i in listed if i.ticker == listing.ticker), None)
            if saved is None and listing.mic == "XLON":
                # Older watchlists saved London symbols without a suffix.
                saved = next(
                    (
                        i
                        for i in listed
                        if i.ticker == listing.symbol
                        and i.exchange.upper() in {"LSE", "LONDON", "LONDON STOCK EXCHANGE"}
                    ),
                    None,
                )
            reading = self.fund_reading(listing, etfs)
            price = any(
                row.get("ticker") == listing.ticker
                and (row.get("isin"), row.get("mic")) == (listing.isin, listing.mic)
                for row in price_directory
            )
            status = "ready" if reading and price else "partial" if reading or price else "pending"
            position = next(iter(accounts.values()))["positions"][0]
            normalized = {
                code: {
                    **account,
                    "positions": [
                        {**p, "ticker": listing.ticker, "broker_ticker": position["broker_ticker"]}
                        if position.get("broker_ticker")
                        else {**p, "ticker": listing.ticker}
                        for p in account["positions"]
                    ],
                }
                for code, account in accounts.items()
            }
            fields = _position_fields(
                _account_holdings({"accounts": normalized}, {}), listing.ticker
            )
            if listing.mic == "XLON":
                fields["broker_listing"] = "LSE:" + listing.symbol
            updates = {
                **fields,
                "ticker": listing.ticker,
                "is_fund": True,
                "fund_isin": listing.isin or (reading.isin if reading else None),
                "us_fund_peers": list(
                    fund_peers(listing.isin or (reading.isin if reading else None))
                ),
                "status": status,
                "last_run_id": manifest.run_id if status != "pending" else None,
                "exchange": listing.exchange or (saved.exchange if saved else ""),
                "last_error": None,
            }
            if saved is not None:
                if saved.ticker != listing.ticker:
                    updates["watchlist_ticker"] = saved.ticker
                listed[listed.index(saved)] = saved.model_copy(update=updates)
            else:
                listed.append(
                    ResearchDirectoryInstrument(
                        **updates,
                        name=str(position.get("name") or listing.ticker),
                        order=len(listed),
                        watchlisted=False,
                    )
                )
        already_listed = {item.ticker for item in listed}
        references = {peer.fund.ticker: peer.fund for item in listed for peer in item.us_fund_peers}
        for ticker, reference in references.items():
            if ticker not in already_listed:
                listed.append(
                    ResearchDirectoryInstrument(
                        ticker=ticker,
                        name=reference.name,
                        exchange=reference.exchange,
                        order=len(listed),
                        status="partial",
                        is_fund=True,
                        watchlisted=False,
                    )
                )
        return listed

    def _held_funds(self, manifest: SnapshotManifest) -> dict[FundListingIdentity, dict[str, dict]]:
        def load():
            raw = (
                self._read_optional(manifest, SECURITY_MASTER_KEY)
                if _artifact(manifest, SECURITY_MASTER_KEY)
                else {}
            )
            catalog = CatalogSecurityMaster(SecurityMasterCatalog.model_validate(raw))
            return held_fund_positions(
                self._broker_snapshot(manifest),
                self._read_optional(manifest, LOOKTHROUGH_KEY),
                self._published_etfs(manifest),
                catalog,
            )

        return self._fund_cache.get_or_compute(manifest.run_id, load)

    def held_fund(
        self,
        ticker: str,
        manifest: SnapshotManifest,
        exchanges: dict[str, tuple[VenueClaim, ...]] | None = None,
    ) -> FundListingIdentity | None:
        ticker = ticker.strip().upper()
        funds = self._held_funds(manifest)
        if exchanges is None:
            exchanges = self.watchlist.listing_exchanges()
        exact = [listing for listing in funds if listing.ticker == ticker]
        candidates = exact
        if not exact and "." not in ticker and not us_fund(ticker):
            candidates = [listing for listing in funds if listing.symbol == ticker]
        matches = [
            listing
            for listing in candidates
            if not resolve_venue(
                ticker,
                *exchanges.get(ticker, ()),
                *row_claims(listing.ticker, {"mic": listing.mic}),
                watchlist_claim(listing.ticker, listing.exchange),
                *exchanges.get(listing.ticker, ()),
                aliases=(listing.ticker,),
            ).conflict
        ]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def fund_reading(listing: FundListingIdentity, etfs: list[ETFReading]) -> ETFReading | None:
        if listing.isin:
            return next((fund for fund in etfs if fund.isin == listing.isin), None)
        return find_etf(etfs, listing.ticker)

    def _fund_price(
        self,
        manifest: SnapshotManifest,
        ticker: str,
        listing: FundListingIdentity | None,
        *,
        with_points: bool = False,
    ) -> JsonObject | None:
        key = FUND_PRICES_KEY if with_points else FUND_PRICE_DIRECTORY_KEY
        if _artifact(manifest, key) is None:
            return None
        rows = self._cached_rows(manifest, key, _fundamentals_rows)
        return next(
            (
                row
                for row in rows
                if row.get("ticker") == ticker
                and (
                    listing is None
                    or (row.get("isin"), row.get("mic")) == (listing.isin, listing.mic)
                )
            ),
            None,
        )

    def _published_etfs(self, manifest: SnapshotManifest):
        if _artifact(manifest, ETF_SUMMARY_KEY) is None:
            return []
        return read_etf_portfolio(self.store, manifest.run_id).funds

    def _broker_snapshot(self, manifest: SnapshotManifest) -> JsonObject:
        """The broker basis the holdings page shows: canonical positions with live values."""

        return overlay_live_broker_snapshot(
            self._read_optional(manifest, BROKER_KEY),
            self._read_optional(manifest, LIVE_BROKER_KEY),
        )

    def _holdings(self, manifest: SnapshotManifest) -> dict[str, JsonObject]:
        return _account_holdings(
            self._broker_snapshot(manifest),
            self._read_optional(manifest, LOOKTHROUGH_KEY),
        )

    def held_position(self, ticker: str, manifest: SnapshotManifest) -> JsonObject | None:
        """Current broker price and listing of the one line holding a security."""

        key = _canonical_ticker(self._route_ticker(ticker))
        item = _account_holdings(self._broker_snapshot(manifest), {}).get(key)
        return item if item and item["held"] and item["price"] is not None else None

    def lens_revision(
        self, manifest: SnapshotManifest, view: str, detail: str, ticker: str = ""
    ) -> str:
        """Account-only snapshots must not invalidate immutable company research."""
        common = {
            CURRENT_MARKET_KEY,
            LEGACY_MARKET_KEY,
            "research/fundamentals.json",
            "research/coverage.json",
            "research/technical.json",
            FUND_PRICES_KEY,
            FUND_PRICE_DIRECTORY_KEY,
        }
        listing = self.held_fund(ticker, manifest) if ticker else None
        reference = us_fund(ticker)
        if listing or reference:
            fund_keys = common | {ETF_SUMMARY_KEY}
            if view in {"overview", "technical"}:
                fund_keys.update({"research/technical.json", "research/coverage.json"})
            if view == "options":
                fund_keys.add("research/options.json")
                fund_keys.add("research/technical.json")
            return fingerprint(
                [
                    listing.key if listing else reference.ticker,
                    self.watchlist.revision(),
                    view,
                    detail,
                    sorted((a.key, a.sha256) for a in manifest.artifacts if a.key in fund_keys),
                    # Chain availability and expiration are time-dependent.
                    datetime.now(UTC).isoformat(timespec="minutes")
                    if view == "options"
                    else datetime.now(UTC).date().isoformat(),
                ]
            )
        if view == "options":
            common.add(FUND_PRICE_DIRECTORY_KEY)

        keys = common | {
            "overview": {
                "research/financials.json",
                "research/earnings.json",
                "research/valuation.json",
                "research/technical.json",
            },
            "technical": {
                "research/technical.json",
                "research/earnings.json",
                "research/analyst.json",
            },
            "valuation": {"research/financials.json", "research/valuation.json"},
            "fundamentals": {
                "research/financials.json",
                "research/earnings.json",
                "research/technical.json",
                "research/analyst.json",
            },
            # The verdict and events name the next report, which can come from the calendar.
            "analyst": {
                "research/financials.json",
                "research/analyst.json",
                "research/earnings.json",
            },
            "options": {"research/options.json", "research/technical.json"},
        }.get(view, set())
        # Exposure and historical records depend on the complete snapshot.
        refs = [
            (a.key, a.sha256)
            for a in manifest.artifacts
            if view in {"overview", "ledger"} or a.key in keys
        ]
        return (
            fingerprint(
                [sorted(refs), detail, self._calendar_days(manifest), self.watchlist.revision()]
            )
            if refs
            else manifest.run_id
        )

    def _calendar_days(self, manifest: SnapshotManifest) -> list[str]:
        """Today's date in UTC and at every covered exchange.

        Lenses name the next report by the exchange's own date, so cached lenses
        roll at each exchange's midnight as well as at UTC midnight.
        """

        now = datetime.now(UTC)
        zones = {
            str((row.get("metrics") or {}).get("exchangeTimezoneName") or "")
            for row in self._cached_rows(manifest, "research/fundamentals.json", _fundamentals_rows)
        }
        return sorted(
            {now.date().isoformat()}
            | {
                f"{zone}:{_exchange_today({'exchangeTimezoneName': zone}, now).isoformat()}"
                for zone in zones
                if zone
            }
        )

    def _fund_technical(self, manifest: SnapshotManifest, ticker: str) -> JsonObject | None:
        # The caller has matched the price directory by ISIN and venue.
        # Never substitute a bare symbol or another listing's technical row.
        return next(
            (
                row
                for row in self._cached_rows(
                    manifest, "research/technical.json", project_technical_rows
                )
                if row["ticker"] == ticker
            ),
            None,
        )

    def _option_chain(
        self, manifest: SnapshotManifest, ticker: str, *, fund: bool = False, pinned=None
    ) -> JsonObject | None:
        pinned = pinned or self.pin_listing(ticker, manifest)
        if pinned.venue().conflict:
            return None
        rows = self._cached_rows(
            manifest, "research/options.json", _raw_options, fallback_key="research/technical.json"
        )
        raw = exact_row(rows, pinned.symbol)
        if not raw or pinned.venue(*row_claims(pinned.symbol, raw)).conflict:
            return None
        if fund and raw.get("currency") != "USD":
            return None
        row = option_rows({"rows": [raw]})[0]
        return {
            **row,
            "availability": chain_availability(
                row["capturedAt"], row["expiries"], allow_unverified_future=fund
            ),
        }

    def _fund_lens(
        self,
        pinned: PinnedListing,
        view: ResearchLensName,
        manifest: SnapshotManifest,
        *,
        detail: str,
    ) -> ResearchLensSnapshot:
        ticker, listing = pinned.ticker, pinned.held
        price = self._fund_price(manifest, ticker, listing)
        reference = us_fund(ticker) if not listing or us_fund_listing(listing) else None
        market = (
            {
                "ticker": ticker,
                "spot": price["spot"],
                "asOf": price["as_of"],
                "currency": price["currency"],
            }
            if price
            else None
        )
        reading = self.fund_reading(listing, self._published_etfs(manifest)) if listing else None
        isin = (listing.isin if listing else None) or (reading.isin if reading else None)
        peers = fund_peers(isin)
        peer = peers[0] if peers else None
        exact = next(
            (
                row
                for row in self._cached_rows(
                    manifest, "research/fundamentals.json", _fundamentals_rows
                )
                if row.get("ticker") == ticker
            ),
            {},
        )
        exact_metrics = exact.get("metrics") or exact.get("info") or {}
        asset_type = observed_product(
            (price or {}).get("asset_type"),
            exact_metrics.get("quoteType"),
            "ETF" if reference or reading else None,
            fund=True,
        )
        options_ticker = (
            ticker
            if reference or (listing and us_fund_listing(listing))
            else peer.fund.ticker
            if peer
            else None
        )
        options = (
            self._option_chain(manifest, options_ticker, fund=True)
            if options_ticker and view == "options"
            else None
        )
        options_peer = peer if options_ticker != ticker and view == "options" else None
        if reference and options and market is None:
            market = {
                "ticker": ticker,
                "spot": options["spot"],
                "currency": "USD",
            }
        metrics = {
            "quoteType": asset_type,
            "isin": isin,
            "exchangeTimezoneName": price["timezone"]
            if price
            else "America/New_York"
            if reference
            else None,
            "fullExchangeName": price["exchange"]
            if price
            else listing.exchange
            if listing
            else reference.exchange
            if reference
            else None,
        }
        fundamental = {"metrics": metrics, "currency": "USD" if reference else None}
        venue = pinned.venue()
        quote = make_quote(ticker, market or {}, fundamental, venue=venue)
        previous = number(price.get("previous_close")) if price else None
        if (
            quote.change is None
            and quote.price is not None
            and previous is not None
            and previous > 0
        ):
            quote.change = quote.price - previous
            quote.change_pct = quote.change / previous
        if listing and not price and not venue.conflict:
            position = next(iter(self._held_funds(manifest)[listing].values()))["positions"][0]
            currency, _ = major_quote_unit(str(position.get("price_currency") or ""))
            quote.currency = currency or quote.currency
            quote.listing = broker_listing(position.get("broker_ticker")) or quote.listing
        quote.schedule = session_schedule(venue.calendar, datetime.now(UTC))
        technical = None
        technical_summary = None
        datasets = []
        if view in {"overview", "technical"}:
            row = self._fund_technical(manifest, ticker) if price else None
            if row is not None:
                coverage = (
                    _find(
                        self._cached_rows(manifest, "research/coverage.json", _fundamentals_rows),
                        ticker,
                    )
                    or {}
                )
                if clock := (coverage.get("datasets") or {}).get("technical"):
                    datasets.append(DatasetClock(dataset="technical", **clock))
                if view == "overview" and detail == "summary":
                    technical_summary = _technical_summary(row)
                else:
                    technical = (
                        row
                        if detail == "full"
                        else {
                            key: value
                            for key, value in row.items()
                            if key not in _TECHNICAL_SEASONALITY
                        }
                    )
        return ResearchLensSnapshot(
            ticker=ticker,
            view=view,
            run_id=manifest.run_id,
            generated_at=manifest.created_at.isoformat(),
            market=market,
            options=OptionSnapshot.model_validate(options) if options else None,
            options_peer=options_peer,
            fundamentals=fundamental if view in {"overview", "fundamentals"} else None,
            technical=technical,
            technical_summary=technical_summary,
            context=ResearchContext(
                quote=quote,
                asset_type=asset_type if asset_type != "CONFLICT" else "UNKNOWN",
                datasets=datasets,
                capabilities=[
                    ResearchCapability(task="overview", state="available"),
                    ResearchCapability(
                        task="fundamentals", state="available" if reading else "missing"
                    ),
                    ResearchCapability(
                        task="technical",
                        state="available" if price else "missing",
                        intervals=["1d"],
                    ),
                    ResearchCapability(task="ledger", state="available"),
                    *[
                        ResearchCapability(task=task, state="notApplicable", reason="fund-research")
                        for task in ("analyst", "valuation")
                    ],
                    ResearchCapability(
                        task="options",
                        state="available"
                        if options
                        else "missing"
                        if options_ticker
                        else "notApplicable",
                        reason=None if options_ticker else "no-verified-us-options-underlying",
                    ),
                ],
            ),
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

        The legacy ticker snapshot remains available for API compatibility.
        The web workbench requests each lens independently; valuation includes
        its financial statement inputs without loading options or timeline
        history into the response.
        """

        pinned = self.pin_listing(ticker, manifest)
        ticker = pinned.symbol
        venue = pinned.venue()
        if venue.conflict:
            return ResearchLensSnapshot(
                ticker=ticker,
                view=view,
                run_id=manifest.run_id,
                generated_at=manifest.created_at.isoformat(),
                context=ResearchContext(
                    quote=make_quote(ticker, {}, {}, venue=venue),
                    asset_type="UNKNOWN",
                    capabilities=[
                        ResearchCapability(task=view, state="missing", reason="listing-conflict")
                    ],
                ),
            )
        if pinned.held or us_fund(ticker):
            return self._fund_lens(pinned, view, manifest, detail=detail)
        market = exact_row(self._market_rows(manifest), ticker)
        payload = ResearchLensSnapshot(
            ticker=ticker,
            view=view,
            run_id=manifest.run_id,
            generated_at=manifest.created_at.isoformat(),
            market=market,
        )

        def event_row(name, parser):
            rows = self._cached_rows(manifest, f"research/{name}.json", parser)
            return pinned.event_row(exact_row(rows, ticker))[0]

        fundamental = event_row("fundamentals", _fundamentals_rows)
        metrics = fundamental.get("metrics") or fundamental.get("info") or {}
        # Report dates are compared with the exchange's calendar date.
        today = _exchange_today(metrics)
        asset_type = str(metrics.get("quoteType") or "UNKNOWN").upper()
        fund_price = self._fund_price(manifest, ticker, None)
        is_fund = (
            asset_type in {"ETF", "MUTUALFUND"}
            or fund_price is not None
            or (
                asset_type == "UNKNOWN"
                and find_etf(self._published_etfs(manifest), ticker) is not None
            )
        )
        if is_fund:
            asset_type = observed_product(
                asset_type, (fund_price or {}).get("asset_type"), fund=True
            )
            if asset_type == "CONFLICT":
                asset_type = "UNKNOWN"
        peers = fund_peers(metrics.get("isin") or (fund_price or {}).get("isin"))
        peer = peers[0] if peers else None
        fund_options_ticker = (
            ticker
            if asset_type == "ETF" and venue.us_listing
            else peer.fund.ticker
            if peer
            else None
        )
        is_financial = any(
            word in str(fundamental.get("industry") or metrics.get("industry") or "").lower()
            for word in ("banks", "banking", "insurance")
        )
        coverage_row = exact_row(
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
                "technical": project_technical_rows,
                "fundamentals": _fundamentals_rows,
                "financials": _financials_rows,
                "analyst": _analyst_rows,
                "valuation": valuation_rows,
                "options": option_rows,
                "earnings": _fundamentals_rows,
            }[name]
            if not exact_row(
                self._cached_rows(manifest, "research/" + name + ".json", parser), ticker
            ):
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
            inappropriate = is_fund and (
                task in {"analyst", "valuation"} or (task == "options" and not fund_options_ticker)
            )
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
        quote = make_quote(ticker, market or {}, fundamental, venue=venue)
        # Sessions of the quote's exchange, so clients name closes and late
        # prices with its holidays and early closes.
        quote.schedule = session_schedule(venue.calendar, datetime.now(UTC))
        payload.context = ResearchContext(
            quote=quote,
            asset_type=asset_type,
            capabilities=capabilities,
            datasets=datasets,
        )
        if view in {"overview", "valuation", "fundamentals", "analyst", "ledger"} and not (
            view == "ledger" and detail in {"summary", "documents"}
        ):
            financial_row = event_row("financials", _financials_rows) or {}
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
            trailing_pe = financial_row.get("trailingPeHistory")
            if (
                view == "valuation"
                and trailing_pe is not None
                and str(financial_row.get("ticker")).upper() == ticker
            ):
                with suppress(ValidationError):
                    payload.trailing_pe_history = TrailingPeHistory.model_validate(trailing_pe)

        if view == "technical" or (view == "overview" and detail != "summary"):
            payload.technical = exact_row(
                self._cached_rows(
                    manifest,
                    "research/technical.json",
                    project_technical_rows,
                ),
                pinned.ticker,
            )
        if not is_fund and (view == "valuation" or (view == "overview" and detail != "summary")):
            payload.valuation = exact_row(
                self._cached_rows(
                    manifest,
                    "research/valuation.json",
                    valuation_rows,
                ),
                ticker,
            )
        if view == "options":
            if is_fund:
                payload.options_peer = peer if fund_options_ticker != ticker else None
                payload.options = (
                    self._option_chain(manifest, fund_options_ticker, fund=True)
                    if fund_options_ticker
                    else None
                )
                for capability in capabilities:
                    if capability.task == "options" and fund_options_ticker:
                        capability.state = "available" if payload.options else "missing"
            else:
                payload.options = self._option_chain(manifest, ticker, pinned=pinned)
        if view == "fundamentals":
            # Reuse parsed immutable rows; enriching one ticker must not parse
            # every statement and every technical history again.
            payload.fundamentals = dict(fundamental)
            calendar = _normalized_earnings_calendar(
                event_row("earnings", _fundamentals_rows),
                today,
            )
            if calendar is not None:
                payload.fundamentals["earningsCalendar"] = calendar
            technical = (
                exact_row(
                    self._cached_rows(manifest, "research/technical.json", project_technical_rows),
                    pinned.ticker,
                )
                or {}
            )
            for key in ("seasonality", "seasonalityCoverage", "seasonalityMatrix", "yearPaths"):
                if key in technical:
                    payload.fundamentals[key] = technical[key]
            analyst = event_row("analyst", _analyst_rows) or {}
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
            financials_row = event_row("financials", _financials_rows)
            payload.financials = financials_row.get("financials") if financials_row else None
        if view in {"analyst", "fundamentals", "ledger"} and not (
            view == "ledger" and detail in {"summary", "documents"}
        ):
            analyst_row = event_row("analyst", _analyst_rows)
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
            payload.technical = {
                **payload.technical,
                "currency": payload.technical.get("currency") or market.get("currency") or "",
            }
        if view == "ledger" and detail == "documents":
            financial_row = event_row("financials", _financials_rows) or {}
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
            # A shared score entry, not another full-lens request or price history.
            summary_row = exact_row(
                self._cached_rows(manifest, "research/technical.json", project_technical_rows),
                pinned.ticker,
            )
            payload.technical_summary = _technical_summary(summary_row)
            payload.technical = None
            payload.valuation = None
            payload.fundamentals = dict(fundamental)
            payload.fundamentals["earningsCalendar"] = _normalized_earnings_calendar(
                event_row("earnings", _fundamentals_rows),
                today,
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
                        key: technical.get(key) for key in _TECHNICAL_SEASONALITY
                    }
                for key in _TECHNICAL_SEASONALITY:
                    technical.pop(key, None)
                payload.technical = technical
            payload.fundamentals = {
                **(payload.fundamentals or {}),
                "earningsCalendar": _normalized_earnings_calendar(
                    event_row("earnings", _fundamentals_rows),
                    today,
                ),
            }
        if view in {"overview", "technical", "fundamentals", "analyst"}:
            # Every lens that names the next report reads this one date.
            analyst_row = event_row("analyst", _analyst_rows)
            payload.next_earnings_date = _next_earnings_date(
                (analyst_row or {}).get("analyst"),
                _normalized_earnings_calendar(
                    event_row("earnings", _fundamentals_rows),
                    today,
                ),
                today,
            )
        return ResearchLensSnapshot.model_validate(payload.__dict__)

    def timeline(
        self,
        ticker: str,
        *,
        limit: int = 30,
    ) -> list[ResearchTimelinePoint]:
        exchanges = self.watchlist.listing_exchanges()
        requested = ticker.upper()
        points: list[ResearchTimelinePoint] = []
        seen: set[tuple[str | None, ...]] = set()
        manifests = self._history_manifests()
        if not manifests:
            return []
        current = self.pin_listing(requested, manifests[0], exchanges=exchanges)
        if current.venue().conflict:
            return []
        requested = current.symbol
        for manifest in manifests:
            artifact_hashes = tuple(
                _artifact(manifest, key).sha256 if _artifact(manifest, key) else None
                for key in (
                    CURRENT_MARKET_KEY,
                    LEGACY_MARKET_KEY,
                    "research/technical.json",
                    "research/options.json",
                    "research/valuation.json",
                    "research/earnings.json",
                    FUND_PRICE_DIRECTORY_KEY,
                    FUND_PRICES_KEY,
                    SECURITY_MASTER_KEY,
                    "research/fundamentals.json",
                )
            )
            pinned = self.pin_listing(requested, manifest, exchanges=exchanges)
            ticker, listing = pinned.symbol, pinned.held
            if pinned.venue(*current.claims).conflict or ticker != current.symbol:
                continue
            signature = (*artifact_hashes, ticker, listing.key if listing else None)
            if signature in seen:
                continue
            seen.add(signature)
            if listing:
                market = None
                technical = (
                    self._fund_technical(manifest, ticker)
                    if self._fund_price(manifest, ticker, listing)
                    else None
                )
            else:
                market = exact_row(self._market_rows(manifest), ticker)
                technical = exact_row(
                    self._cached_rows(manifest, "research/technical.json", project_technical_rows),
                    pinned.ticker,
                )
            valuation = (
                None
                if listing
                else exact_row(
                    self._cached_rows(manifest, "research/valuation.json", valuation_rows),
                    ticker,
                )
            )
            options = self._option_chain(manifest, ticker, pinned=pinned) if not listing else None
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
                self._cached_rows(manifest, "research/valuation.json", valuation_rows),
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
        snapshot = self.ticker_snapshot(ticker, manifest)
        ticker = snapshot.ticker
        alerts: list[ResearchAlert] = []
        pinned = self.pin_listing(ticker, manifest)

        def quote_for(row):
            return (
                self.live_alerts.quote(
                    ticker,
                    snapshot_run_id=manifest.run_id,
                    pinned=pinned,
                    unit=row.get("currency") or "",
                )
                if self.live_alerts
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
                if isinstance(bull, (int, float)) and 0 < bull < spot:
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
            live_quote = quote_for(technical)
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
            live_quote = quote_for(snapshot.options)
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
            partial(
                self.pin_listing, manifest=manifest, exchanges=self.watchlist.listing_exchanges()
            ),
        )
        requested_ticker = self.pin_listing(ticker, manifest).symbol if ticker else None
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

    def pin_listing(self, ticker, manifest, *, exchanges=None) -> PinnedListing:
        """Select the chart row once, retaining its original symbol and all venue claims."""
        requested = ticker.strip().upper()
        if exchanges is None:
            exchanges = self.watchlist.listing_exchanges()
        listing = self.held_fund(requested, manifest, exchanges)
        route = listing.ticker if listing else self._route_ticker(requested, exchanges)
        technicals = self._published_technicals(manifest)
        exact = exact_row(technicals.get("rows") or [], requested)
        if (
            route != requested
            and exact
            and resolve_venue(
                requested, *row_claims(requested, exact), VenueClaim("symbol", route, route)
            ).conflict
        ):
            route, listing = requested, None
        reference = us_fund(route)
        technical = _find(technicals.get("rows") or [], route)
        fund_price = self._fund_price(manifest, route, listing, with_points=True)
        source = fund_price or (None if listing or reference else technical)
        published = str((source or {}).get("ticker") or route).upper()
        aliases = {route} if route != requested else set()
        if published != route and _canonical_ticker(published) == _canonical_ticker(route):
            # The historic BASE / BASE.L spelling is safe only with independent
            # London evidence on the observed row or its own watchlist entry.
            evidence = resolve_venue(
                published, *exchanges.get(published, ()), *row_claims(published, source)
            )
            if evidence.venues == {"XLON"}:
                aliases.add(published)
        claims = []
        for symbol in dict.fromkeys((requested, route, published)):
            claims.extend(exchanges.get(symbol, ()))
            claims.append(VenueClaim("symbol", symbol, symbol))
        fundamentals = self._cached_rows(manifest, "research/fundamentals.json", _fundamentals_rows)
        markets = self._cached_rows(
            manifest, CURRENT_MARKET_KEY, _market_rows_with_claims, fallback_key=LEGACY_MARKET_KEY
        )
        fund_rows = [
            row
            for key in (FUND_PRICE_DIRECTORY_KEY, FUND_PRICES_KEY)
            if _artifact(manifest, key)
            for row in self._cached_rows(manifest, key, _fundamentals_rows)
        ]
        for symbol in dict.fromkeys((requested, route, published)):
            for row in (
                exact_row(technicals.get("rows") or [], symbol),
                exact_row(fundamentals, symbol),
                *(row for row in fund_rows if row.get("ticker") == symbol),
            ):
                if row:
                    claims.extend(row_claims(symbol, row))
            if market := exact_row(markets, symbol):
                claims.extend(market["_venue_claims"])
        if listing:
            claims.extend(row_claims(listing.ticker, {"mic": listing.mic}))
            claims.append(watchlist_claim(listing.ticker, listing.exchange))
        if reference:
            claims.append(provider_claim(reference.exchange, route))
        return PinnedListing(
            requested,
            route,
            published,
            tuple(claims),
            tuple(sorted(aliases)),
            listing,
            source,
            bool(fund_price),
        )

    def bind_price_series(self):
        """Freeze the chart and event routing together before a snapshot-bound run."""
        exchanges = self.watchlist.listing_exchanges()
        return partial(self.price_series, exchanges=exchanges), partial(
            self.pin_listing, exchanges=exchanges
        )

    def price_series(self, ticker, manifest, *, limit=504, exchanges=None, pinned=None):
        pinned = pinned or self.pin_listing(ticker, manifest, exchanges=exchanges)
        if pinned.venue().conflict:
            raise VenueConflict(f"incompatible venue claims for {ticker}")
        series = self._published_price_series(pinned, manifest, limit=limit)
        venue = self.price_venue(pinned, series)
        series.exchange_calendar = venue.calendar
        return series

    @staticmethod
    def price_venue(pinned, series):
        """Live provider claims refine the same raw price evidence as the published chart."""
        observed = series.published_bar_ticker or series.ticker
        claims = [
            *series.venue_claims,
            VenueClaim("identity", observed, pinned.ticker),
            *row_claims(
                observed,
                {"mic": series.published_bar_mic, "exchange": series.published_bar_exchange},
            ),
        ]
        if series.source == ALPACA_SIP:
            claims.append(VenueClaim("region", "US", observed))
        venue = pinned.venue(*claims)
        if venue.conflict:
            raise VenueConflict(f"incompatible venue claims for {pinned.requested}")
        series.venue_claims = (*pinned.claims, *claims)
        return venue

    def _published_technicals(self, manifest: SnapshotManifest) -> JsonObject:
        key = "research/technical.json"
        ref = _artifact(manifest, key)
        return self._raw_price_cache.get_or_compute(
            ref.sha256 if ref else manifest.run_id, lambda: self._read_optional(manifest, key)
        )

    def _marker_listings(
        self, manifest: SnapshotManifest, markers: JsonObject
    ) -> dict[str, set[str]]:
        """Inventory the listings in this publication, independent of current routing aliases."""

        def load():
            symbols = {listing.ticker for listing in self._held_funds(manifest)}
            technicals = self._published_technicals(manifest)
            symbols.update(
                str(row.get("ticker") or "").upper()
                for row in technicals.get("rows") or []
                if isinstance(row, dict)
            )
            for key in (FUND_PRICES_KEY, FUND_PRICE_DIRECTORY_KEY, "research/fundamentals.json"):
                if _artifact(manifest, key):
                    rows = self._cached_rows(manifest, key, _fundamentals_rows)
                    symbols.update(str(r.get("ticker") or "").upper() for r in rows)
            symbols.update(str(r["ticker"]).upper() for r in self._market_rows(manifest))
            symbols.update(
                symbol
                for row in markers["rows"]
                if isinstance(row, dict)
                for fill in row.get("fills") or []
                if (symbol := broker_symbol(fill.get("broker_ticker")))
            )
            aliases = defaultdict(set)
            for account in self._broker_snapshot(manifest).get("accounts", {}).values():
                for position in account.get("positions") or []:
                    instrument = position.get("broker_ticker")
                    if symbol := broker_symbol(instrument):
                        symbols.add(symbol)
                        # Old publications uppercased the case-sensitive broker instrument.
                        aliases[instrument.strip().upper()].add(symbol)
            for symbol in symbols:
                aliases[symbol].add(symbol)
                aliases[symbol.partition(".")[0]].add(symbol)
            return dict(aliases)

        return self._facts_cache.get_or_compute((manifest.run_id, "marker_listings"), load)

    def trade_markers(
        self, manifest: SnapshotManifest, ticker: str, currency: str
    ) -> tuple[list[ResearchTradeMarker], dict[str, set[str]] | None]:
        """Project the pinned fills for the listing and quote unit of the returned bars."""

        def load():
            key = "account/trade_markers.json"
            raw = self._read_optional(manifest, key) if _artifact(manifest, key) else {}
            return chart_trade_markers(
                raw, ticker, currency, lambda: self._marker_listings(manifest, raw)
            )

        return self._facts_cache.get_or_compute(
            (manifest.run_id, "trade_markers", ticker, currency), load
        )

    def _published_price_series(
        self, pinned: PinnedListing, manifest: SnapshotManifest, *, limit: int = 504
    ) -> ResearchPriceSeries:
        """Read the price row selected with the rest of this listing's evidence."""
        ticker = pinned.route
        if sum(listing.ticker == ticker for listing in self._held_funds(manifest)) > 1:
            raise FileNotFoundError(f"ambiguous published fund listing for {ticker}")
        fund_price = pinned.fund_bars
        artifact = _artifact(manifest, FUND_PRICES_KEY if fund_price else "research/technical.json")
        cache_key = (manifest.run_id, ticker, pinned.symbol, pinned.ticker)
        if cached := self._price_series_cache.get(cache_key):
            return _visible_price_sessions(cached, limit)
        raw = {} if fund_price else self._published_technicals(manifest)
        source = pinned.price_row
        if source is None:
            raise FileNotFoundError(f"technical research not found for {ticker}")
        bar_ticker = str(source["ticker"]).strip().upper()
        raw_points = source.get("price_series")
        all_points = [
            PriceSeriesPoint.model_validate(point)
            for point in (raw_points if isinstance(raw_points, list) else [])
            if isinstance(point, dict)
        ]
        as_of = str(source.get("as_of") or raw.get("as_of") or "")
        market = (
            {}
            if fund_price
            else next(
                (row for row in self._market_rows(manifest) if row.get("ticker") == bar_ticker), {}
            )
        )
        currency = str(source.get("currency") or market.get("currency") or "")
        all_markers, unresolved = self.trade_markers(manifest, pinned.symbol, currency)
        exchange = source.get("exchange")
        series = ResearchPriceSeries(
            unresolved_trade_accounts=unresolved,
            published_bar_ticker=bar_ticker,
            published_bar_asset_type=source.get("asset_type"),
            published_fund_row=bool(fund_price),
            venue_claims=row_claims(bar_ticker, source),
            published_bar_mic=source.get("mic"),
            published_bar_segment=source.get("market_segment"),
            published_bar_exchange=exchange,
            published_series_id=published_price_series_id(artifact.sha256, ticker)
            if artifact
            else None,
            ticker=ticker,
            as_of=as_of,
            currency=currency,
            available_sessions=len(all_points),
            points=all_points,
            trade_markers=all_markers,
            events=[
                {"date": p.date, "kind": kind, "value": value, "currency": currency}
                for p in all_points
                for kind, value in (("dividend", p.dividend), ("split", p.split))
                if value
            ],
        )
        if len(self._price_series_cache) >= 128:
            self._price_series_cache.clear()
        self._price_series_cache[cache_key] = series
        return _visible_price_sessions(series, limit)
