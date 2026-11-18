"""Resolve claims about one listing without conflating provider namespaces or calendars."""

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal, NamedTuple

# Yahoo Finance exchange suffixes and chart meta.exchangeName/fullExchangeName.
# https://help.yahoo.com/kb/finance-for-web/SLN2310.html
# https://query1.finance.yahoo.com/v8/finance/chart/AAPL.VI
YAHOO_SUFFIX_BY_MIC = {
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
    "XDUB": ".IR",
    "XKRX": ".KS",
    "XTAI": ".TW",
    "XCSE": ".CO",
    "XHEL": ".HE",
    "XLIS": ".LS",
    "XOSL": ".OL",
    "XWBO": ".VI",
    "XNAS": "",
    "XNYS": "",
    "ARCX": "",
    "XKOS": ".KQ",
    "ROCO": ".TWO",
    "XNSE": ".NS",
    "XBOM": ".BO",
    "XSES": ".SI",
    "XSHG": ".SS",
    "XSHE": ".SZ",
    "XJSE": ".JO",
    "BVMF": ".SA",
    "XMEX": ".MX",
    "XCNQ": ".CN",
    "NEOE": ".NE",
    "XTSX": ".V",
}
YAHOO_MIC_BY_SUFFIX = {s: mic for mic, s in YAHOO_SUFFIX_BY_MIC.items() if s}


def _codes(rows):
    return {code: mic for mic, values in rows.items() for code in values.split()}


_YAHOO = _codes(
    {
        "XNYS": "NYQ NYSE",
        "XNAS": "NASDAQ",
        "XNGS": "NMS NASDAQGS",
        "XNMS": "NGM NASDAQGM",
        "XNCM": "NCM NASDAQCM",
        "ARCX": "PCX NYSEARCA",
        "XASE": "ASE NYSEAMERICAN",
        "BATS": "BTS CBOEUS",
        "OTCM": "PNK OQB OQX OTCMARKETSOTCPK OTCMARKETSOTCQB OTCMARKETSOTCQX",
        "XLON": "LSE",
        "XFRA": "FRA FRANKFURT",
        "XETR": "GER XETRA",
        "XAMS": "AMS AMSTERDAM",
        "XBRU": "BRU BRUSSELS",
        "XMAD": "MCE",
        "XSTO": "STO STOCKHOLM",
        "XHKG": "HKG HKSE",
        "XTKS": "JPX TOKYO",
        "XASX": "ASX",
        "XTSE": "TOR TORONTO",
        "XPAR": "PAR PARIS",
        "XMIL": "MIL MILAN",
        "XSWX": "EBS SWISS",
        "XDUB": "ISE IRISH",
        "XKRX": "KSC KSE",
        "XKOS": "KOE KOSDAQ",
        "XTAI": "TAI TAIWAN",
        "XCSE": "CPH COPENHAGEN",
        "XHEL": "HEL HELSINKI",
        "XLIS": "LIS LISBON",
        "XOSL": "OSL OSLO",
        "XWBO": "VIE VIENNA",
        "ROCO": "TWO TAIPEIEXCHANGE",
        "XNSE": "NSI NSE",
        "XBOM": "BSE",
        "XSES": "SES",
        "XSHG": "SHH SHANGHAI",
        "XSHE": "SHZ SHENZHEN",
        "XJSE": "JNB JOHANNESBURG",
        "BVMF": "SAO SÃOPAULO",
        "XMEX": "MEX MEXICO",
        "XCNQ": "CNQ CANADIANSEC",
        "NEOE": "NEO CBOECA",
        "XTSX": "VAN TSXV",
    }
)

# Exchange Code (not Composite Code), https://www.openfigi.com/about/exchange-codes
_FIGI = _codes(
    {
        "XNYS": "UN",
        "XNGS": "UW",
        "XNMS": "UQ",
        "XNCM": "UR",
        "ARCX": "UP",
        "XASE": "UA",
        "BATS": "UF",
        "OTCM": "UV",
        "XLON": "LN LI",
        "XFRA": "GF",
        "XETR": "GY",
        "XAMS": "NA",
        "XBRU": "BB",
        "XMCE": "SQ",
        "XSTO": "SS",
        "XHKG": "HK",
        "XTKS": "JT",
        "XASX": "AT",
        "XTSE": "CT",
        "XPAR": "FP",
        "XMIL": "IM",
        "XSWX": "SE",
        "XDUB": "ID",
        "XKRX": "KP",
        "XKOS": "KQ",
        "XCSE": "DC",
        "XHEL": "FH",
        "XLIS": "PL",
        "XOSL": "NO",
        "XWBO": "AV",
        "XNSE": "IS",
        "XBOM": "IB",
        "XSOM": "BO",
        "XSES": "SP",
        "XJSE": "SJ",
        "XTSX": "CV",
        "XSHG": "CG",
        "XSHE": "CS",
    }
)

# ISO 10383 venue identities. Nasdaq's operating MIC includes three listing tiers.
# https://www.iso20022.org/market-identifier-codes
_NASDAQ = frozenset({"XNMS", "XNGS", "XNCM"})
_MICS = {
    mic: frozenset({mic})
    for mic in [
        "ARCX",
        "BATS",
        "BATY",
        "BVMF",
        "NEOE",
        "OTCM",
        "ROCO",
        "XAMS",
        "XASE",
        "XASX",
        "XBOM",
        "XBRU",
        "XCNQ",
        "XCSE",
        "XDUB",
        "XETR",
        "XFRA",
        "XHEL",
        "XHKG",
        "XJSE",
        "XKOS",
        "XKRX",
        "XLIS",
        "XLON",
        "XMAD",
        "XMCE",
        "XMEX",
        "XMIL",
        "XNCM",
        "XNGS",
        "XNMS",
        "XNSE",
        "XNYS",
        "XOSE",
        "XOSL",
        "XPAR",
        "XSES",
        "XSHG",
        "XSHE",
        "XSOM",
        "XSTO",
        "XSWX",
        "XTAI",
        "XTKS",
        "XTSE",
        "XTSX",
        "XWBO",
    ]
}
_MICS["XNAS"] = _NASDAQ

# Only membership in the supported markets is inferred from a composite.
# A composite alone never identifies a trading schedule.
_MARKETS = {
    code: frozenset(mics.split())
    for code, mics in {
        "US": "XNYS XNGS XNMS XNCM XASE ARCX BATS BATY OTCM",
        "GR": "XFRA XETR",
        "JP": "XTKS XOSE",
        "KS": "XKRX XKOS",
        "TT": "XTAI ROCO",
        "IN": "XNSE XBOM",
        "CN": "XTSE XTSX XCNQ NEOE",
        "AU": "XASX",
        "SM": "XMAD XMCE",
        "SW": "XSWX",
        "CH": "XSHG XSHE",
        "BZ": "BVMF XSOM",
        "MM": "XMEX",
    }.items()
}

# Trading Max's historical watchlist/reference display names, independent of provider codes.
_NAMES = _codes(
    {
        "XNAS": "NASDAQ",
        "ARCX": "ARCA",
        "XASE": "AMEX NYSEMKT",
        "BATS": "CBOEBZX BZX",
        "XLON": "LONDON LONDONSTOCKEXCHANGE LON",
        "XFRA": "FRANKFURTSTOCKEXCHANGE",
        "XHKG": "HONGKONG HKEX",
        "XBOM": "BOMBAYSTOCKEXCHANGE",
        "XTSE": "TSX",
    }
)
# Published ISO names retained in legacy watchlists and provider descriptions.
_NAMES.update(
    {
        "ASX-ALLMARKETS": "XASX",
        "B3S.A.-BRASILBOLSABALCAO": "BVMF",
        "BOLSADEMADRID": "XMAD",
        "BOLSADEVALORESDESAOPAULO-SOMA": "XSOM",
        "BOLSAMEXICANADEVALORES(MEXICANSTOCKEXCHANGE)": "XMEX",
        "BORSAITALIANAS.P.A.": "XMIL",
        "BSELTD": "XBOM",
        "CANADIANSECURITIESEXCHANGE": "XCNQ",
        "CBOEBYXU.S.EQUITIESEXCHANGE": "BATY",
        "CBOEBZXU.S.EQUITIESEXCHANGE": "BATS",
        "CBOECANADA-NEO-L(MARKETBYORDER)": "NEOE",
        "DEUTSCHEBOERSEAG": "XFRA",
        "EURONEXT-EURONEXTAMSTERDAM": "XAMS",
        "EURONEXT-EURONEXTBRUSSELS": "XBRU",
        "EURONEXT-EURONEXTLISBON": "XLIS",
        "EURONEXT-EURONEXTPARIS": "XPAR",
        "HONGKONGEXCHANGESANDCLEARINGLTD": "XHKG",
        "IRISHSTOCKEXCHANGE-ALLMARKET": "XDUB",
        "JOHANNESBURGSTOCKEXCHANGE": "XJSE",
        "KOREAEXCHANGE(KOSDAQ)": "XKOS",
        "KOREAEXCHANGE(STOCKMARKET)": "XKRX",
        "LONDONSTOCKEXCHANGE": "XLON",
        "MERCADOCONTINUOESPANOL-CONTINUOUSMARKET": "XMCE",
        "NASDAQ-ALLMARKETS": "XNAS",
        "NASDAQCAPITALMARKET": "XNCM",
        "NASDAQCOPENHAGENA/S": "XCSE",
        "NASDAQGLOBALMARKET": "XNMS",
        "NASDAQGLOBALSELECTMARKET": "XNGS",
        "NASDAQHELSINKILTD": "XHEL",
        "NASDAQSTOCKHOLMAB": "XSTO",
        "NATIONALSTOCKEXCHANGEOFINDIA": "XNSE",
        "NEWYORKSTOCKEXCHANGE,INC.": "XNYS",
        "NYSEAMERICANLLC": "XASE",
        "NYSEARCA": "ARCX",
        "OSAKAEXCHANGE": "XOSE",
        "OSLOBORS": "XOSL",
        "OTCLINKATS-OTCMARKETS": "OTCM",
        "SHANGHAISTOCKEXCHANGE": "XSHG",
        "SHENZHENSTOCKEXCHANGE": "XSHE",
        "SINGAPOREEXCHANGE": "XSES",
        "SIXSWISSEXCHANGE": "XSWX",
        "TAIPEIEXCHANGE": "ROCO",
        "TAIWANSTOCKEXCHANGE": "XTAI",
        "TOKYOSTOCKEXCHANGE": "XTKS",
        "TORONTOSTOCKEXCHANGE": "XTSE",
        "TSXVENTUREEXCHANGE": "XTSX",
        "WIENERBOERSEAG": "XWBO",
        "XETRA": "XETR",
    }
)
_CALENDARS = {
    name: name
    for name in [
        "XLON",
        "XAMS",
        "XETR",
        "XFRA",
        "XBRU",
        "XMAD",
        "XSTO",
        "XHKG",
        "XTKS",
        "XASX",
        "XTSE",
        "XPAR",
        "XMIL",
        "XSWX",
        "XDUB",
        "XKRX",
        "XTAI",
        "XCSE",
        "XHEL",
        "XLIS",
        "XOSL",
        "XWBO",
    ]
}
_CALENDARS.update(dict.fromkeys(["XNYS", *_NASDAQ, "XASE", "ARCX", "BATS"], "XNYS"))
_CALENDARS["XMCE"] = "XMAD"


class VenueClaim(NamedTuple):
    source: Literal[
        "symbol", "mic", "yahoo", "fundamentals", "openfigi", "region", "market", "name"
    ]
    value: str | None
    listing: str | None = None


@dataclass(frozen=True)
class VenueResolution:
    venues: frozenset[str]
    conflict: bool = False
    calendar: str | None = None

    @property
    def us_listing(self) -> bool:
        return bool(self.venues) and self.venues <= _MARKETS["US"]


class VenueConflict(FileNotFoundError):
    """Verified evidence identifies incompatible listings."""


def _code(value):
    return "".join(str(value or "").upper().split())


def watchlist_claim(listing, value):
    """The legacy exchange column stores FIGI codes, defaults, MICs and display names."""
    code = _code(value)
    if code in _MARKETS:
        source = "market"
    elif code in _FIGI:
        source = "openfigi"
    elif code in _MICS:
        source = "mic"
    else:
        source = "name" if code in _NAMES else "yahoo"
    return VenueClaim(source, value, listing)


def watchlist_claims(listing, exchange, bloomberg_ticker="", source=None):
    """Bloomberg tickers can carry another claim. The generated US suffix is a default."""
    words = str(bloomberg_ticker or "").upper().split()
    named = None if _code(exchange) in {"UNKNOWN", "N/A", "-"} else exchange
    claims = [VenueClaim(source, named, listing) if source else watchlist_claim(listing, named)]
    if len(words) >= 3 and words[-1] == "EQUITY":
        code = words[-2]
        claims.append(VenueClaim("market" if code in _MARKETS else "openfigi", code, listing))
    return tuple(claims)


def provider_claim(value, listing=None):
    """Older published exchange columns can contain a normalised MIC or reference name."""
    code = _code(value)
    source = "mic" if code in _MICS else "name" if code in _NAMES else "yahoo"
    return VenueClaim(source, value, listing)


def yahoo_venue_metadata(metadata):
    """Persist the Yahoo chart identity separately from the historical display column."""
    return {
        key: metadata[key]
        for key in ("symbol", "mic", "exchangeName", "fullExchangeName")
        if metadata.get(key)
    }


def row_claims(listing, row, metrics=None):
    metrics = metrics or row.get("metrics") or row.get("info") or {}
    provider = row.get("provider_venue") or row.get("providerVenue") or {}
    claims = [
        VenueClaim("symbol", listing, listing),
        VenueClaim("symbol", row.get("ticker"), listing),
        VenueClaim("symbol", row.get("yf_ticker") or row.get("yfTicker"), listing),
        VenueClaim("symbol", metrics.get("symbol"), listing),
        VenueClaim("mic", metrics.get("mic"), listing),
        VenueClaim("fundamentals", metrics.get("exchange"), listing),
        VenueClaim("fundamentals", metrics.get("exchangeName"), listing),
        VenueClaim("fundamentals", metrics.get("fullExchangeName"), listing),
    ]
    # New price rows keep both raw provider values. The display exchange on
    # older publications can be a MIC, a reference name or a provider code.
    if row.get("exchange") and row["exchange"] not in (
        provider.get("exchangeName"),
        provider.get("fullExchangeName"),
    ):
        claims.append(provider_claim(row["exchange"], listing))
    for observed in (row, provider):
        claims.extend(
            (
                VenueClaim("symbol", observed.get("symbol"), listing),
                VenueClaim("mic", observed.get("mic"), listing),
                VenueClaim("yahoo", observed.get("exchangeName"), listing),
                VenueClaim("yahoo", observed.get("fullExchangeName"), listing),
            )
        )
    return tuple(claim for claim in claims if claim.value)


def resolve_venue(requested: str | None, *claims: VenueClaim) -> VenueResolution:
    """Intersect explicit claims. Use a market default only within its own unqualified listing."""
    explicit = defaultdict(list)
    defaults = defaultdict(list)
    unknown = False
    specific = False
    symbols = {requested, *(claim.listing for claim in claims if claim.listing)}
    suffixes = [VenueClaim("symbol", symbol, symbol) for symbol in symbols]
    for source, value, listing in (*suffixes, *claims):
        code = _code(value)
        if not code:
            continue
        owner = _code(listing or requested)
        if source == "region":
            if code in _MARKETS:
                explicit[owner].append(_MARKETS[code])
            else:
                unknown = True
            continue
        if source == "market":
            if code in _MARKETS:
                defaults[owner].append(_MARKETS[code])
            continue
        if source == "symbol":
            mic = YAHOO_MIC_BY_SUFFIX.get("." + code.rpartition(".")[2]) if "." in code else None
            if not mic:
                continue
        elif source == "openfigi":
            if code in _FIGI:
                mic = _FIGI[code]
            elif code in _MARKETS:
                explicit[owner].append(_MARKETS[code])
                continue
            else:
                mic = None
        elif source == "mic":
            mic = code
        elif source == "name":
            mic = _NAMES.get(code)
        else:
            mic = _YAHOO.get(code)
        if mic in _MICS:
            specific = True
            explicit[owner].append(_MICS[mic])
        else:
            unknown = True
    groups = [
        claim
        for owner in explicit.keys() | defaults.keys()
        for claim in (explicit.get(owner) or defaults[owner])
    ]
    venues = frozenset.intersection(*groups) if groups else frozenset()
    calendars = {_CALENDARS.get(mic) for mic in venues}
    calendar = calendars.pop() if specific and not unknown and len(calendars) == 1 else None
    return VenueResolution(venues, bool(groups and not venues), calendar)
