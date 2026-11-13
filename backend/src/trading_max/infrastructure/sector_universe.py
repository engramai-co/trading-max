"""Index universes for the sector board, read from issuers' published ETF holdings.

Each market's board covers one broad index through an iShares UCITS ETF that
tracks it. The issuer's product data supplies the constituents, their weights
and GICS sectors; the market-data symbol follows from the listing exchange and
local ticker. Cash, collateral, futures, rights and zero-weight placeholders
are left out, as are residual holdings a fund cannot sell (suspended shares
written down to almost nothing), and the remaining weights renormalised to one.
"""

from __future__ import annotations

import json
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from pydantic import Field

from trading_max.domain import DomainModel

from .fund_holdings import ISHARES_API, USER_AGENT, _atomic_json, _get_json, _iso_date

GICS_SECTORS: dict[str, str] = {
    "Energy": "10",
    "Materials": "15",
    "Industrials": "20",
    "Consumer Discretionary": "25",
    "Consumer Staples": "30",
    "Health Care": "35",
    "Financials": "40",
    "Information Technology": "45",
    "Communication Services": "50",
    "Utilities": "55",
    "Real Estate": "60",
}
SECTOR_ALIASES = {"Communication": "Communication Services"}
FIELDS = ("ticker", "issueName", "isin", "exchange", "sectorName", "holdingPercent", "assetClass")
# Percent of the fund. Every live constituent of these indices weighs far more.
RESIDUAL_WEIGHT_PCT = 0.001
_TICKER = re.compile(r"[A-Z0-9]+(?:-[A-Z0-9]+)*")


@dataclass(frozen=True, slots=True)
class UniverseSpec:
    """Where one market's constituents come from and how they are quoted."""

    market: str
    universe: str
    fund: str
    fund_ticker: str
    product_id: str
    exchanges: Mapping[str, str]
    """Issuer exchange name to market-data symbol suffix."""
    unlisted_suffix: str | None = None
    """Suffix for equities the issuer lists without an exchange (London trusts)."""
    regional: bool = False
    """The fund also holds other markets' listings, which are skipped quietly."""

    @property
    def source_url(self) -> str:
        return f"https://www.ishares.com/uk/individual/en/products/{self.product_id}"


UNIVERSES: dict[str, UniverseSpec] = {
    "us": UniverseSpec(
        market="us",
        universe="S&P 500",
        fund="iShares Core S&P 500 UCITS ETF",
        fund_ticker="CSPX",
        product_id="253743",
        exchanges={
            "New York Stock Exchange Inc.": "",
            "NASDAQ": "",
            "Cboe BZX": "",
            "NYSE Arca": "",
            "NYSE MKT LLC": "",
        },
    ),
    "ndx": UniverseSpec(
        market="ndx",
        universe="Nasdaq 100",
        fund="iShares NASDAQ 100 UCITS ETF",
        fund_ticker="CNDX",
        product_id="253741",
        exchanges={"NASDAQ": ""},
    ),
    "uk": UniverseSpec(
        market="uk",
        universe="FTSE 100",
        fund="iShares Core FTSE 100 UCITS ETF",
        fund_ticker="ISF",
        product_id="251795",
        exchanges={"London Stock Exchange": ".L"},
        unlisted_suffix=".L",
    ),
    "eu": UniverseSpec(
        market="eu",
        universe="MSCI Europe",
        fund="iShares Core MSCI Europe UCITS ETF",
        fund_ticker="SMEA",
        product_id="251861",
        exchanges={
            "Bolsa De Madrid": ".MC",
            "Borsa Italiana": ".MI",
            "Deutsche Boerse Xetra": ".DE",
            "Euronext Amsterdam": ".AS",
            "Irish Stock Exchange - All Market": ".IR",
            "London Stock Exchange": ".L",
            "Nasdaq Omx Helsinki Ltd.": ".HE",
            "Nasdaq Omx Nordic": ".ST",
            "Nyse Euronext - Euronext Brussels": ".BR",
            "Nyse Euronext - Euronext Lisbon": ".LS",
            "Nyse Euronext - Euronext Paris": ".PA",
            "Omx Nordic Exchange Copenhagen A/S": ".CO",
            "Oslo Bors Asa": ".OL",
            "SIX Swiss Exchange": ".SW",
            "Wiener Boerse Ag": ".VI",
            "Xetra": ".DE",
            # Some European issuers' primary listings trade in the US.
            "NASDAQ": "",
            "New York Stock Exchange Inc.": "",
        },
    ),
    "hk": UniverseSpec(
        market="hk",
        universe="MSCI AC Far East ex Japan, Hong Kong listings",
        fund="iShares MSCI AC Far East ex-Japan UCITS ETF",
        fund_ticker="IFFF",
        product_id="251848",
        exchanges={"Hong Kong Exchanges And Clearing Ltd": ".HK"},
        regional=True,
    ),
    "jp": UniverseSpec(
        market="jp",
        universe="MSCI Japan",
        fund="iShares MSCI Japan UCITS ETF",
        fund_ticker="IJPN",
        product_id="251866",
        exchanges={"Tokyo Stock Exchange": ".T"},
    ),
    "tw": UniverseSpec(
        market="tw",
        universe="MSCI Taiwan",
        fund="iShares MSCI Taiwan UCITS ETF",
        fund_ticker="ITWN",
        product_id="251878",
        exchanges={"Taiwan Stock Exchange": ".TW", "Gretai Securities Market": ".TWO"},
    ),
    "in": UniverseSpec(
        market="in",
        universe="MSCI India",
        fund="iShares MSCI India UCITS ETF",
        fund_ticker="NDIA",
        product_id="297617",
        exchanges={"National Stock Exchange Of India": ".NS", "Bse Ltd": ".BO"},
    ),
    "ca": UniverseSpec(
        market="ca",
        universe="MSCI Canada",
        fund="iShares MSCI Canada UCITS ETF",
        fund_ticker="CSCA",
        product_id="253721",
        exchanges={"Toronto Stock Exchange": ".TO"},
    ),
    "au": UniverseSpec(
        market="au",
        universe="MSCI Australia",
        fund="iShares MSCI Australia UCITS ETF",
        fund_ticker="SAUS",
        product_id="251851",
        exchanges={"Asx - All Markets": ".AX"},
    ),
    "kr": UniverseSpec(
        market="kr",
        universe="MSCI Korea",
        fund="iShares MSCI Korea UCITS ETF",
        fund_ticker="CSKR",
        product_id="253733",
        exchanges={"Korea Exchange (Stock Market)": ".KS", "Korea Exchange (Kosdaq)": ".KQ"},
    ),
}


class SectorConstituent(DomainModel):
    symbol: str = Field(description="Market-data symbol, for example AAPL, BT-A.L, 0700.HK.")
    ticker: str = Field(description="The issuer's local ticker.")
    name: str
    isin: str = ""
    exchange: str = ""
    sector_code: str
    sector_name: str
    weight: float = Field(ge=0, description="Fraction of the universe; constituents sum to one.")


class ExcludedHolding(DomainModel):
    ticker: str
    name: str
    reason: str
    weight_pct: float = 0.0


class SectorUniverse(DomainModel):
    schema_version: int = 1
    market: str
    universe: str
    fund: str
    fund_ticker: str
    source_url: str
    as_of: str
    fetched_at: str
    constituents: list[SectorConstituent] = Field(default_factory=list)
    excluded: list[ExcludedHolding] = Field(default_factory=list)


# Yahoo uses mnemonic symbols for these BSE listings while the issuer uses
# BSE security codes. These are aliases for the same listings, not NSE prices.
BSE_YAHOO_CODES = {"534091": "MCX", "532483": "CANBK"}


def provider_symbol(spec: UniverseSpec, ticker: str | None, exchange: str | None) -> str | None:
    """The market-data symbol of one issuer holding, or None when it is not quotable here.

    US share classes use a hyphen (``BRK B`` → ``BRK-B``); London drops the
    issuer's trailing dot (``RR.`` → ``RR.L``, ``BT.A`` → ``BT-A.L``); Nordic classes
    also use a hyphen (``NOVO B`` → ``NOVO-B.CO``, ``VOLV B`` → ``VOLV-B.ST``). Hong Kong
    codes are four digits (``700`` → ``0700.HK``); Korean codes six (``.KS`` or
    ``.KQ`` by board).
    """

    raw = (ticker or "").strip().upper()
    if not raw:
        return None
    suffix = spec.unlisted_suffix if not exchange else spec.exchanges.get(exchange)
    if suffix is None:
        return None
    if suffix == ".HK":
        return f"{int(raw):04d}.HK" if raw.isdigit() else None
    if suffix in {".KS", ".KQ"}:
        return f"{raw.zfill(6)}{suffix}" if raw.isdigit() and len(raw) <= 6 else None
    if suffix in {".TW", ".TWO"}:
        return f"{raw}{suffix}" if re.fullmatch(r"[0-9]{4}", raw) else None
    if suffix == ".BO":
        raw = BSE_YAHOO_CODES.get(raw, raw)
    if suffix == ".T":
        # TSE codes can also carry a letter (e.g. 130A); do not strip it.
        return raw + suffix if re.fullmatch(r"[0-9][0-9A-Z]{3}", raw) else None
    base = re.sub(r"[ .]+", "-", raw.rstrip(".")).strip("-")
    pattern = r"[A-Z0-9]+(?:[-&][A-Z0-9]+)*" if suffix in {".NS", ".BO"} else _TICKER
    return base + suffix if re.fullmatch(pattern, base) else None


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number == number else 0.0


def parse_universe(
    spec: UniverseSpec,
    points: Mapping[str, Any],
    *,
    fetched_at: datetime,
) -> SectorUniverse:
    """Normalise the issuer's holdings data points into one market's universe."""

    columns = {name: list((points.get(name) or {}).get("value") or []) for name in FIELDS}
    length = len(columns["holdingPercent"])
    if length == 0 or any(len(values) != length for values in columns.values()):
        raise ValueError(f"{spec.fund_ticker}: holdings arrays are incomplete")
    kept: dict[str, dict[str, Any]] = {}
    excluded: list[ExcludedHolding] = []
    for index in range(length):
        if str(columns["assetClass"][index] or "") != "Equity":
            continue  # cash, collateral and futures are not constituents
        exchange = str(columns["exchange"][index] or "")
        ticker = str(columns["ticker"][index] or "").strip()
        name = " ".join(str(columns["issueName"][index] or ticker).split())
        weight = _number(columns["holdingPercent"][index])
        if exchange and exchange not in spec.exchanges and spec.regional:
            continue  # another market's listing in a regional fund
        sector_name = str(columns["sectorName"][index] or "").strip()
        sector_name = SECTOR_ALIASES.get(sector_name, sector_name)
        symbol = provider_symbol(spec, ticker, exchange or None)
        reason = (
            "not quoted on this market"
            if symbol is None
            else "residual holding"
            if weight < RESIDUAL_WEIGHT_PCT
            else "no GICS sector"
            if sector_name not in GICS_SECTORS
            else ""
        )
        if reason:
            excluded.append(
                ExcludedHolding(ticker=ticker, name=name, reason=reason, weight_pct=weight)
            )
            continue
        if symbol in kept:
            kept[symbol]["weight"] += weight
            continue
        kept[symbol] = {
            "symbol": symbol,
            "ticker": ticker,
            "name": name,
            "isin": str(columns["isin"][index] or "").strip().upper(),
            "exchange": exchange,
            "sector_code": GICS_SECTORS[sector_name],
            "sector_name": sector_name,
            "weight": weight,
        }
    total = sum(row["weight"] for row in kept.values())
    if total <= 0:
        raise ValueError(f"{spec.fund_ticker}: no {spec.market} constituents in the holdings")
    constituents = sorted(
        (SectorConstituent(**{**row, "weight": row["weight"] / total}) for row in kept.values()),
        key=lambda item: (-item.weight, item.symbol),
    )
    return SectorUniverse(
        market=spec.market,
        universe=spec.universe,
        fund=spec.fund,
        fund_ticker=spec.fund_ticker,
        source_url=spec.source_url,
        as_of=_iso_date((points.get("asOfDate") or {}).get("value")),
        fetched_at=fetched_at.isoformat(),
        constituents=constituents,
        excluded=excluded,
    )


def ishares_holdings_client(*, timeout: float = 30.0) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"},
    )


def fetch_ishares_holdings(product_id: str, client: httpx.Client) -> dict[str, Any]:
    """Read the issuer's holdings fields shared by sector and global markets."""

    payload = _get_json(
        client,
        ISHARES_API,
        params={
            "appSubType": "ISHARES",
            "appType": "PRODUCT_PAGE",
            "component": "holdings.all",
            "locale": "en_GB",
            "portfolioId": product_id,
            "targetSite": "ishares-uk",
            "userType": "individual",
            "excludeContent": "true",
            "includeConfig": "true",
        },
    )
    try:
        points = payload["componentsByNameMap"]["holdings"]["containersByNameMap"]["all"][
            "dataPointsByNameMap"
        ]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{product_id}: iShares holdings schema changed") from exc
    if not isinstance(points, dict) or str(payload.get("productId", product_id)) != product_id:
        raise ValueError(f"{product_id}: iShares holdings product mismatch")
    return points


def fetch_universe(spec: UniverseSpec, client: httpx.Client, *, now: datetime) -> SectorUniverse:
    """Download one market's universe from the issuer's product data."""
    return parse_universe(spec, fetch_ishares_holdings(spec.product_id, client), fetched_at=now)


class SectorUniverseProvider:
    """Cached market universes: refreshed after a day, kept when the issuer is unavailable."""

    def __init__(
        self,
        data_root: Path,
        *,
        max_age: timedelta = timedelta(hours=20),
        fetcher: Callable[[UniverseSpec], SectorUniverse] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.root = data_root / "research-cache" / "sector-universe"
        self.max_age = max_age
        self.fetcher = fetcher
        self._now = now or (lambda: datetime.now(UTC))
        self._memory: dict[str, SectorUniverse] = {}
        self._locks = {market: threading.Lock() for market in UNIVERSES}

    def _path(self, market: str) -> Path:
        return self.root / f"{market}.json"

    def _cached(self, market: str) -> SectorUniverse | None:
        if market in self._memory:
            return self._memory[market]
        try:
            universe = SectorUniverse.model_validate_json(self._path(market).read_bytes())
        except (OSError, ValueError):
            return None
        self._memory[market] = universe
        return universe

    def _fresh(self, universe: SectorUniverse) -> bool:
        try:
            fetched = datetime.fromisoformat(universe.fetched_at)
        except ValueError:
            return False
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=UTC)
        return timedelta(0) <= self._now() - fetched <= self.max_age

    def _fetch(self, spec: UniverseSpec) -> SectorUniverse:
        if self.fetcher is not None:
            return self.fetcher(spec)
        with ishares_holdings_client() as client:
            return fetch_universe(spec, client, now=self._now())

    def get(self, market: str) -> SectorUniverse:
        """The market's universe; a stale cache is served when a refresh fails."""

        with self._locks[market]:
            return self._get(market)

    def _get(self, market: str) -> SectorUniverse:
        spec = UNIVERSES[market]
        cached = self._cached(market)
        if cached is not None and self._fresh(cached):
            return cached
        try:
            universe = self._fetch(spec)
        except Exception:
            if cached is not None:
                return cached
            raise
        _atomic_json(self._path(market), json.loads(universe.model_dump_json(by_alias=True)))
        self._memory[market] = universe
        return universe


__all__ = [
    "GICS_SECTORS",
    "UNIVERSES",
    "ExcludedHolding",
    "SectorConstituent",
    "SectorUniverse",
    "SectorUniverseProvider",
    "UniverseSpec",
    "fetch_universe",
    "parse_universe",
    "provider_symbol",
]
