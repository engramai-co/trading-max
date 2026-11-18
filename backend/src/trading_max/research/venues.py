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
        "XCNQ": "CNQ CANADIANSECURITIESEXCHANGE",
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
    for mic in set(YAHOO_SUFFIX_BY_MIC) | set(_FIGI.values()) | {"BATY", "XOSE"}
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
_CALENDARS = {
    name: name
    for name in "XLON XAMS XETR XFRA XBRU XMAD XSTO XHKG XTKS XASX XTSE XPAR XMIL XSWX XDUB XKRX XTAI XCSE XHEL XLIS XOSL XWBO".split()
}
_CALENDARS.update(dict.fromkeys(["XNYS", *_NASDAQ, "XASE", "ARCX", "BATS"], "XNYS"))
_CALENDARS["XMCE"] = "XMAD"


class VenueClaim(NamedTuple):
    source: Literal["symbol", "mic", "yahoo", "fundamentals", "openfigi", "market", "name"]
    value: str | None
    listing: str | None = None


@dataclass(frozen=True)
class VenueResolution:
    venues: frozenset[str]
    conflict: bool = False
    calendar: str | None = None


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


def provider_claim(value, listing=None):
    """Older published exchange columns can contain a normalised MIC or reference name."""
    code = _code(value)
    source = "mic" if code in _MICS else "name" if code in _NAMES else "yahoo"
    return VenueClaim(source, value, listing)


def row_claims(listing, row, metrics=None):
    metrics = metrics or {}
    return (
        VenueClaim("symbol", listing, listing),
        VenueClaim("mic", row.get("mic"), listing),
        provider_claim(row.get("exchange"), listing),
        VenueClaim("yahoo", row.get("fullExchangeName"), listing),
        VenueClaim("fundamentals", metrics.get("exchange"), listing),
        VenueClaim("fundamentals", metrics.get("fullExchangeName"), listing),
    )


def resolve_venue(requested: str | None, *claims: VenueClaim) -> VenueResolution:
    """Intersect explicit claims. Use a market default only within its own unqualified listing."""
    explicit = defaultdict(list)
    defaults = defaultdict(list)
    unknown = False
    for source, value, listing in (VenueClaim("symbol", requested), *claims):
        code = _code(value)
        if not code:
            continue
        owner = _code(listing or requested)
        if source == "market":
            if code in _MARKETS:
                defaults[owner].append(_MARKETS[code])
            continue
        if source == "symbol":
            mic = YAHOO_MIC_BY_SUFFIX.get("." + code.rpartition(".")[2]) if "." in code else None
            if not mic:
                continue
        elif source == "openfigi":
            if code in _MARKETS:
                explicit[owner].append(_MARKETS[code])
                continue
            mic = _FIGI.get(code)
        elif source == "mic":
            mic = code
        elif source == "name":
            mic = _NAMES.get(code)
        else:
            mic = _YAHOO.get(code)
        if mic in _MICS:
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
    calendar = calendars.pop() if explicit and not unknown and len(calendars) == 1 else None
    return VenueResolution(venues, bool(groups and not venues), calendar)
