"""Market identifiers for named quote venues and security-master listings."""

_VENUES = {
    "NMS": "XNAS",
    "NGM": "XNAS",
    "NCM": "XNAS",
    "NYQ": "XNYS",
    "ASE": "XASE",
    "PCX": "ARCX",
    "NASDAQ": "XNAS",
    "NYSE": "XNYS",
    "NEW YORK STOCK EXCHANGE": "XNYS",
    "NYSE ARCA": "ARCX",
    "LONDON STOCK EXCHANGE": "XLON",
    "LSE": "XLON",
    "LONDON": "XLON",
    "HKG": "XHKG",
    "HKSE": "XHKG",
    "JPX": "XTKS",
    "TOKYO": "XTKS",
    "KSC": "XKRX",
    "KSE": "XKRX",
    "KOSPI": "XKRX",
    "KOREA EXCHANGE (STOCK MARKET)": "XKRX",
    "KOE": "XKOS",
    "KOSDAQ": "XKOS",
    "KOREA EXCHANGE (KOSDAQ)": "XKOS",
    "TOR": "XTSE",
    "ASX": "XASX",
    "GER": "XETR",
    "XETRA": "XETR",
    "FRA": "XFRA",
    "FRANKFURT": "XFRA",
    "NASDAQGS": "XNAS",
    "NASDAQGM": "XNAS",
    "NASDAQCM": "XNAS",
    "NYSE AMERICAN": "XASE",
    "NYSEARCA": "ARCX",
    "CPH": "XCSE",
    "COPENHAGEN": "XCSE",
    "STO": "XSTO",
    "STOCKHOLM": "XSTO",
    "HEL": "XHEL",
    "HELSINKI": "XHEL",
    "OSL": "XOSL",
    "OSLO": "XOSL",
    "LIS": "XLIS",
    "LISBON": "XLIS",
    "VIE": "XWBO",
    "VIENNA": "XWBO",
    "WSE": "XWAR",
    "WARSAW": "XWAR",
    "PARIS": "XPAR",
    "AMSTERDAM": "XAMS",
    "BRU": "XBRU",
    "BRUSSELS": "XBRU",
    "MIL": "XMIL",
    "MILAN": "XMIL",
    "MCE": "XMAD",
    "MADRID": "XMAD",
    "EBS": "XSWX",
    "SWISS": "XSWX",
    "ISE": "XDUB",
    "IRISH": "XDUB",
    "PAR": "XPAR",
    "AMS": "XAMS",
}
_MICS = frozenset(_VENUES.values())


def venue_mic(exchange: str | None) -> str | None:
    """Use explicit venue evidence from a provider name, code or supported MIC."""
    name = str(exchange or "").strip().upper()
    return name if name in _MICS else _VENUES.get(name)


def listing_mic(exchange: str, mic: str) -> str | None:
    """A supplied MIC must identify a venue and agree with any named exchange."""
    named = venue_mic(exchange)
    if not mic:
        return named
    identified = venue_mic(mic)
    return identified if named is None or named == identified else None


_SUFFIXES = {
    "XLON": (".L",),
    "XHKG": (".HK",),
    "XTKS": (".T",),
    "XKRX": (".KS",),
    "XKOS": (".KQ",),
    "XPAR": (".PA",),
    "XAMS": (".AS",),
    "XBRU": (".BR",),
    "XETR": (".DE",),
    "XFRA": (".F",),
    "XMIL": (".MI",),
    "XMAD": (".MC",),
    "XSWX": (".SW",),
    "XDUB": (".IR",),
    "XCSE": (".CO",),
    "XSTO": (".ST",),
    "XHEL": (".HE",),
    "XOSL": (".OL",),
    "XLIS": (".LS",),
    "XWBO": (".VI",),
    "XWAR": (".WA",),
}


def local_venue_symbol(ticker: str, mic: str | None) -> str:
    """Remove only a quote-provider suffix that belongs to this venue."""
    ticker = ticker.strip().upper()
    for suffix in _SUFFIXES.get(mic, ()):
        if len(ticker) > len(suffix) and ticker.endswith(suffix):
            return ticker.removesuffix(suffix)
    return ticker
