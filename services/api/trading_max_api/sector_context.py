"""Portfolio and research inputs to the sector boards.

Exposure is the latest look-through value of each economic issuer. Look-through
rows resolved by the security master carry its entity; unresolved rows keep
their ISIN. Constituents resolve through the same security master. Each
look-through value is assigned once, shared by index weight among the listings
it belongs to (an issuer's share classes, or the listings of one ISIN).
Research tickers link constituents to the research desk, and research themes
form a second grouping of listings with positive evidence of a US venue.
"""

from __future__ import annotations

import json
import logging
import math
import statistics
import threading
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from trading_max.analytics.sector_board import BoardMember, GroupLabel
from trading_max.infrastructure.sector_universe import SectorConstituent
from trading_max.reference import CatalogSecurityMaster, SecurityDescriptor

from .models import SnapshotManifest, WatchlistItem, WatchlistState
from .sector_models import SectorMarketCode

LOGGER = logging.getLogger(__name__)

LOOKTHROUGH_KEY = "account/lookthrough_metrics.json"
FUNDAMENTALS_KEY = "research/fundamentals.json"
US_SHARE_CLASSES = frozenset({"A", "B", "C"})
MIN_THEME_MEMBERS = 3


def _codes(text: str) -> frozenset[str]:
    return frozenset(text.split())


# Listing venues as watchlist items and providers name them (exchange names,
# provider codes, MICs and Bloomberg exchange codes), compared without spaces.
VENUES: dict[str, frozenset[str]] = {
    "us": _codes(
        """
        US UN UW UQ UR UA UP UV NYSE NASDAQ AMEX ARCA BATS CBOE OTC NYSEARCA NYSEAMERICAN
        NYSEMKT NASDAQGS NASDAQGM NASDAQCM NMS NGM NCM NGS NYQ ASE PCX BTS PNK OQB OQX XNYS
        XNAS XASE ARCX BATY
        """
    ),
    "uk": _codes("LSE LON LONDON XLON IOB LN"),
    "hk": _codes("HKG HKEX HKSE XHKG HK"),
    "jp": _codes("JPX TYO XTKS TOKYOSTOCKEXCHANGE JP JT"),
    "kr": _codes("KSC KOE KRX KSE KOSPI KOSDAQ XKRX XKOS KS KQ"),
}
# Venues of markets without a board. Naming one keeps a listing off every board.
FOREIGN_VENUES = _codes(
    """
    AMS PAR BRU LIS GER FRA XETRA ETR MIL MCE VIE SWX EBS STO CPH HEL OSL ISE TOR TSX CNQ
    NEO OSA ASX SES SGX TAI TWO SHH SHZ NSE BSE JNB SAO MEX XAMS XPAR XETR XFRA
    XMIL XSWX XTSE XASX NA FP GY GR IM SM SW SE SS DC FH NO CN CT AU SP TT CH
    IN IB SJ BZ MM
    """
)
SUFFIX_MARKETS = {".L": "uk", ".HK": "hk", ".KS": "kr", ".KQ": "kr", ".T": "jp"}
# Exchange values that name no venue. Only these let a Bloomberg exchange code
# stand in, since watchlist items default to a generic "<ticker> US Equity".
UNNAMED_EXCHANGES = frozenset({"", "UNKNOWN", "N/A", "-"})


@dataclass(frozen=True, slots=True)
class PortfolioExposure:
    """The latest snapshot's look-through values and research market caps."""

    run_id: str | None = None
    by_entity: Mapping[str, float] = field(default_factory=dict)
    by_isin: Mapping[str, float] = field(default_factory=dict)
    invested_gbp: float | None = None
    market_caps: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Resolution:
    """A constituent's issuer and GICS industry group, when the security master knows them."""

    entity_id: str | None = None
    subgroup: str = ""
    subgroup_name: str = ""


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _venue(exchange: str, bloomberg_ticker: str) -> str | None:
    """The market a listing venue names: a board market, "foreign", or None.

    A named exchange decides alone, even one these lists do not know; a
    Bloomberg exchange code counts only when no exchange is named.
    """

    code = "".join(exchange.upper().split())
    if code in UNNAMED_EXCHANGES:
        words = bloomberg_ticker.strip().upper().split()
        code = words[-2] if len(words) >= 3 else ""
    market = next((market for market, venues in VENUES.items() if code in venues), None)
    if market is not None:
        return market
    return "foreign" if code in FOREIGN_VENUES else None


def _local_code(market: str, value: str) -> str | None:
    base = next(
        (value[: -len(suffix)] for suffix in SUFFIX_MARKETS if value.endswith(suffix)), value
    )
    if market == "hk":
        return f"{int(base):04d}" if base.isdigit() else None
    if market == "kr":
        return base if base.isdigit() else None
    if market == "jp":
        return base if len(base) == 4 and base[0].isdigit() and base.isalnum() else None
    return base.replace(".", "-") or None


def market_key(
    ticker: str, exchange: str = "", bloomberg_ticker: str = ""
) -> tuple[str, str] | None:
    """The board market and local code a research ticker quotes, or None.

    A listing suffix (``.L``, ``.HK``, ``.KS``, ``.KQ``) or a named venue
    places a listing; an unsuffixed ticker counts as US only with a US venue. A
    named foreign venue or a foreign suffix keeps the listing off every board,
    and a generic US venue never overrides an explicit listing suffix.
    The venue is the named exchange; a Bloomberg exchange code counts only
    when none is named, so an exchange these lists do not know places nothing.
    """

    value = ticker.strip().upper()
    if not value:
        return None
    suffix = next((market for end, market in SUFFIX_MARKETS.items() if value.endswith(end)), None)
    if suffix is None and "." in value:
        base, _, letter = value.rpartition(".")
        if not (base.isalpha() and letter in US_SHARE_CLASSES):
            return None  # another market's suffix
    venue = _venue(exchange, bloomberg_ticker)
    if venue == "foreign":
        return None
    if suffix is not None and venue not in (None, "us", suffix):
        return None  # the venue and the suffix disagree
    market = suffix or venue
    if market is None:
        return None
    code = _local_code(market, value)
    return (market, code) if code else None


def member_key(market: SectorMarketCode, symbol: str) -> tuple[str, str]:
    """The research lookup key of a board member's market-data symbol."""

    if market == "us":
        return (market, symbol)
    return (market, symbol.rpartition(".")[0])


def research_index(items: Iterable[WatchlistItem]) -> dict[tuple[str, str], str]:
    """Research tickers by the market and local code they quote."""

    index: dict[tuple[str, str], str] = {}
    for item in items:
        key = market_key(item.ticker, item.exchange, item.bloomberg_ticker)
        if key is not None:
            index.setdefault(key, item.ticker)
    return index


def portfolio_exposure(store: Any, manifest: SnapshotManifest | None) -> PortfolioExposure:
    """Read look-through values and research market caps from one snapshot."""

    if manifest is None:
        return PortfolioExposure()

    def read(key: str) -> dict[str, Any]:
        try:
            payload = store.read_json(manifest.run_id, key)
        except (FileNotFoundError, KeyError, ValueError):
            return {}
        return payload if isinstance(payload, dict) else {}

    lookthrough = read(LOOKTHROUGH_KEY)
    by_entity: defaultdict[str, float] = defaultdict(float)
    by_isin: defaultdict[str, float] = defaultdict(float)
    for row in lookthrough.get("positions") or []:
        if not isinstance(row, Mapping):
            continue
        value = _positive(row.get("valueGbp"))
        if value is None:
            continue
        entity = str(row.get("entityId") or "")
        isin = str(row.get("isin") or "").strip().upper()
        if entity and not entity.startswith("unresolved:"):
            by_entity[entity] += value
        elif isin:
            by_isin[isin] += value
    caps: dict[str, float] = {}
    for row in read(FUNDAMENTALS_KEY).get("rows") or []:
        if not isinstance(row, Mapping):
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        cap = _positive((row.get("metrics") or {}).get("marketCap"))
        if ticker and cap is not None:
            caps[ticker] = cap
    return PortfolioExposure(
        run_id=manifest.run_id,
        by_entity=dict(by_entity),
        by_isin=dict(by_isin),
        invested_gbp=_positive(lookthrough.get("investedValueGbp")),
        market_caps=caps,
    )


class SecurityMasterCache:
    """The installation's security master, reloaded when its catalog files change."""

    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root
        self.paths = (
            data_root / "reference" / "security-master.json",
            data_root / "reference" / "security-master-overrides.json",
        )
        self._lock = threading.Lock()
        self._signature: tuple[tuple[int, int] | None, ...] | None = None
        self._master = CatalogSecurityMaster.default()

    def signature(self) -> tuple[tuple[int, int] | None, ...]:
        signature: list[tuple[int, int] | None] = []
        for path in self.paths:
            try:
                stat = path.stat()
            except FileNotFoundError:
                signature.append(None)
            else:
                signature.append((stat.st_mtime_ns, stat.st_size))
        return tuple(signature)

    def get(self) -> CatalogSecurityMaster:
        signature = self.signature()
        with self._lock:
            if signature != self._signature:
                try:
                    self._master = CatalogSecurityMaster.from_state_root(self.data_root)
                except (OSError, ValueError, json.JSONDecodeError):
                    LOGGER.warning("security master unavailable for sector boards", exc_info=True)
                    self._master = CatalogSecurityMaster.default()
                self._signature = signature
            return self._master


def resolve_constituents(
    master: CatalogSecurityMaster, constituents: Iterable[SectorConstituent]
) -> dict[str, Resolution]:
    """Issuer and industry group of each constituent.

    An industry group is used only when its sector agrees with the issuer's,
    so a doubtful match never moves a company into another sector's block.
    """

    resolved: dict[str, Resolution] = {}
    for constituent in constituents:
        entity = master.resolve(
            SecurityDescriptor(
                ticker=constituent.ticker, name=constituent.name, isin=constituent.isin
            )
        )
        if entity.method == "unresolved":
            resolved[constituent.symbol] = Resolution()
            continue
        gics = entity.gics
        same_sector = gics is not None and gics.sector_code == constituent.sector_code
        resolved[constituent.symbol] = Resolution(
            entity_id=entity.entity_id,
            subgroup=gics.industry_group_code if gics is not None and same_sector else "",
            subgroup_name=gics.industry_group_name if gics is not None and same_sector else "",
        )
    return resolved


def shared_exposure(
    rows: Sequence[tuple[str, str | None, str, float]],
    portfolio: PortfolioExposure,
) -> dict[str, float]:
    """Exposure per symbol from (symbol, entity, ISIN, weight) rows.

    Each look-through value is assigned once: an issuer's value to the listings
    resolved to it, an unresolved ISIN's value to the listings with that ISIN,
    each shared by weight (equally when no listing has weight). A listing can
    take part of both, never the same value twice.
    """

    exposure = {symbol: 0.0 for symbol, *_ in rows}
    claims: defaultdict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    for symbol, entity, isin, weight in rows:
        if entity and entity in portfolio.by_entity:
            claims[("entity", entity)].append((symbol, max(weight, 0.0)))
        if isin and isin.upper() in portfolio.by_isin:
            claims[("isin", isin.upper())].append((symbol, max(weight, 0.0)))
    for (kind, key), listings in claims.items():
        value = portfolio.by_entity[key] if kind == "entity" else portfolio.by_isin[key]
        total = sum(weight for _, weight in listings)
        for symbol, weight in listings:
            exposure[symbol] += value * (weight / total if total > 0 else 1 / len(listings))
    return exposure


@dataclass(frozen=True, slots=True)
class ThemeGrouping:
    labels: list[GroupLabel]
    members: list[BoardMember]


def theme_grouping(
    state: WatchlistState,
    master: CatalogSecurityMaster,
    portfolio: PortfolioExposure,
    *,
    universe: Mapping[str, tuple[str | None, str]] | None = None,
) -> ThemeGrouping:
    """Research themes over their US listings, weighted by market capitalisation.

    A listing joins only with evidence of a US venue. A member without a known
    capitalisation takes its theme's median, and a theme without any takes
    the median of every themed US listing's, so currencies never mix. Themes
    with fewer than three members are left out before prices are known.
    ``universe`` gives the issuer and ISIN of index constituents by symbol.
    """

    themes = sorted(
        state.research_themes or state.categories, key=lambda theme: (theme.order, theme.id)
    )
    by_theme: defaultdict[str, list[tuple[str, WatchlistItem]]] = defaultdict(list)
    for item in state.items:
        theme_id = item.research_theme_id or item.category_id
        key = market_key(item.ticker, item.exchange, item.bloomberg_ticker)
        if theme_id and key is not None and key[0] == "us":
            by_theme[theme_id].append((key[1], item))

    def known_cap(symbol: str, item: WatchlistItem) -> float | None:
        caps = portfolio.market_caps
        return caps.get(item.ticker.strip().upper()) or caps.get(symbol)

    # Research holds each listing's cap in its own currency; these are all
    # US listings, so their caps compare.
    themed_caps = {
        symbol: cap
        for members in by_theme.values()
        for symbol, item in members
        if (cap := known_cap(symbol, item)) is not None
    }
    fallback_cap = statistics.median(themed_caps.values()) if themed_caps else 1.0
    listings = universe or {}
    labels: list[GroupLabel] = []
    rows: list[tuple[str, str, str, str, float, str | None, str]] = []
    for theme in themes:
        # One row per listing, even if the watchlist names it twice.
        members = list(dict(by_theme.get(theme.id, [])).items())
        if len(members) < MIN_THEME_MEMBERS:
            continue
        caps = [known_cap(symbol, item) for symbol, item in members]
        present = [cap for cap in caps if cap is not None]
        median = statistics.median(present) if present else fallback_cap
        labels.append(GroupLabel(key=theme.id, name=theme.label_en, name_zh=theme.label_zh))
        for (symbol, item), cap in zip(members, caps, strict=True):
            entity, isin = listings.get(symbol, (None, ""))
            if entity is None:
                resolved = master.resolve(
                    SecurityDescriptor(
                        ticker=item.ticker,
                        name=item.name,
                        exchange=item.exchange,
                        figi=item.figi,
                        composite_figi=item.composite_figi,
                        share_class_figi=item.share_class_figi,
                    )
                )
                entity = None if resolved.method == "unresolved" else resolved.entity_id
            rows.append((symbol, item.name, item.ticker, theme.id, cap or median, entity, isin))
    exposure = shared_exposure(
        [(symbol, entity, isin, cap) for symbol, _, _, _, cap, entity, isin in rows], portfolio
    )
    return ThemeGrouping(
        labels=labels,
        members=[
            BoardMember(
                symbol=symbol,
                name=name,
                group=theme_id,
                weight=cap,
                exposure_gbp=exposure.get(symbol, 0.0),
                research_ticker=ticker,
            )
            for symbol, name, ticker, theme_id, cap, _, _ in rows
        ],
    )


__all__ = [
    "FUNDAMENTALS_KEY",
    "LOOKTHROUGH_KEY",
    "MIN_THEME_MEMBERS",
    "PortfolioExposure",
    "Resolution",
    "SecurityMasterCache",
    "ThemeGrouping",
    "market_key",
    "member_key",
    "portfolio_exposure",
    "research_index",
    "resolve_constituents",
    "shared_exposure",
    "theme_grouping",
]
