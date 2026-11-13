"""Direct fund listings. The issuer evidence belongs to the share class, not the quote."""

from dataclasses import dataclass, field

from trading_max.analytics.etf_projection import ETFReading
from trading_max.reference import CatalogSecurityMaster, SecurityDescriptor, is_fund_instrument

from .listing import LONDON, broker_listing

FUND_PRICE_DIRECTORY_KEY = "research/fund_price_directory.json"
FUND_PRICES_KEY = "research/fund_prices.json"
BROKER_SNAPSHOT_KEY = "account/broker_snapshot_metrics.json"
LOOKTHROUGH_KEY = "account/lookthrough_metrics.json"
SECURITY_MASTER_KEY = "reference/security_master.json"

_SUFFIX_BY_MIC = {
    "XLON": ".L",
    "XAMS": ".AS",
    "XETR": ".DE",
    "XFRA": ".F",
    "XBRU": ".BR",
    "XMAD": ".MC",
    "XSTO": ".ST",
    "XHKG": ".HK",
    "XTKS": ".T",
    "XASX": ".AX",
    "XTSE": ".TO",
    "XPAR": ".PA",
    "XMIL": ".MI",
    "XSWX": ".SW",
    "XNYS": "",
    "XNAS": "",
    "ARCX": "",
}
_MIC_BY_SUFFIX = {suffix: mic for mic, suffix in _SUFFIX_BY_MIC.items() if suffix}


def _text(value: object) -> str:
    return str(value or "").strip().upper()


@dataclass(frozen=True)
class FundListingIdentity:
    isin: str
    mic: str
    symbol: str
    ticker: str = field(compare=False)
    exchange: str = field(compare=False)

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.isin, self.mic, self.symbol)


def fund_listing(position: dict, catalog: CatalogSecurityMaster) -> FundListingIdentity:
    ticker = _text(position.get("ticker"))
    isin = _text(position.get("isin"))
    mic = _text(position.get("mic"))
    exchange = _text(position.get("exchange"))
    if listing := broker_listing(position.get("broker_ticker")):
        market, symbol = listing.split(":", 1)
        if market == LONDON:
            return FundListingIdentity(isin, "XLON", symbol, symbol + ".L", market)
        if not mic:
            # The broker confirms a US listing; an exact catalog listing can narrow its MIC.
            exchange = market
        ticker = symbol
    base, dot, venue = ticker.rpartition(".")
    if dot and (suffix := "." + venue) in _MIC_BY_SUFFIX:
        return FundListingIdentity(
            isin, mic or _MIC_BY_SUFFIX[suffix], base, ticker, exchange or _MIC_BY_SUFFIX[suffix]
        )
    if exchange in {"LSE", "LONDON", "LONDON STOCK EXCHANGE"}:
        mic = mic or "XLON"
    if mic in _SUFFIX_BY_MIC:
        return FundListingIdentity(isin, mic, ticker, ticker + _SUFFIX_BY_MIC[mic], exchange or mic)

    # A provider-qualified symbol must describe this exact listing. Do not choose
    # another listing of the same ISIN just because it uses the same currency.
    if isin:
        matches = set()
        for record in catalog.catalog.records:
            for observed in record.listings:
                if _text(observed.isin) != isin:
                    continue
                symbol = _text(observed.ticker)
                venue_mic = _text(observed.mic)
                if not venue_mic:
                    venue_mic = _MIC_BY_SUFFIX.get("." + symbol.rpartition(".")[2], "")
                suffix = _SUFFIX_BY_MIC.get(venue_mic, "")
                if exchange == "US" and suffix:
                    continue
                if symbol.removesuffix(suffix) == ticker:
                    matches.add(
                        (venue_mic, symbol + suffix if suffix and symbol == ticker else symbol)
                    )
        if len(matches) == 1:
            mic, qualified = next(iter(matches))
            return FundListingIdentity(isin, mic, ticker, qualified, exchange or mic)
    return FundListingIdentity(isin, mic, ticker, ticker, exchange)


def known_fund(
    catalog: CatalogSecurityMaster, ticker: str, *, isin: str = "", name: str = ""
) -> bool:
    resolved = catalog.resolve(SecurityDescriptor(ticker=ticker, isin=isin, name=name))
    return (
        is_fund_instrument(
            quote_type=resolved.security_type,
            provider_security_type=resolved.provider_security_type,
            provider_security_type2=resolved.provider_security_type2,
        )
        or resolved.security_type == "MUTUALFUND"
    )


def held_fund_positions(
    broker: dict,
    lookthrough: dict,
    readings: list[ETFReading],
    catalog: CatalogSecurityMaster,
) -> dict[FundListingIdentity, dict[str, dict]]:
    """Deduplicate account lines by ISIN, MIC and symbol; use local evidence only."""
    recorded = lookthrough.get("fundPositions")
    rows = recorded if isinstance(recorded, list) else lookthrough.get("sources") or []
    identities = {
        (_text(row.get("ticker")), _text(row.get("isin"))) for row in rows if isinstance(row, dict)
    }
    identities.update((ticker, fund.isin or "") for fund in readings for ticker in fund.tickers)
    share_classes = {isin for _, isin in identities if isin}
    observed_symbols = {ticker for ticker, _ in identities}
    positions: dict[FundListingIdentity, dict[str, dict]] = {}
    for account, snapshot in (broker.get("accounts") or {}).items():
        if not isinstance(snapshot, dict):
            continue
        for position in snapshot.get("positions") or []:
            if not isinstance(position, dict) or not (ticker := _text(position.get("ticker"))):
                continue
            try:
                if position.get("quantity") is not None and float(position["quantity"]) <= 0:
                    continue
            except (TypeError, ValueError):
                continue
            listing = fund_listing(position, catalog)
            if not (
                (listing.isin in share_classes if listing.isin else ticker in observed_symbols)
                or known_fund(
                    catalog, listing.ticker, isin=listing.isin, name=str(position.get("name") or "")
                )
                or (listing.ticker != ticker and known_fund(catalog, ticker, isin=listing.isin))
            ):
                continue
            positions.setdefault(listing, {}).setdefault(account, {**snapshot, "positions": []})[
                "positions"
            ].append(position)
    return positions
