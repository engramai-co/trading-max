"""Security-master projections of source-tagged venue and symbol evidence."""


def venue_mic(exchange: str | None) -> str | None:
    from trading_max.research.venues import provider_claim, resolve_venue

    return resolve_venue(None, provider_claim(exchange)).mic


def listing_mic(exchange: str, mic: str) -> str | None:
    """A supplied MIC must identify a venue and agree with any named exchange."""
    from trading_max.research.venues import VenueClaim, provider_claim, resolve_venue

    if not mic:
        return venue_mic(exchange)
    identified = resolve_venue(None, VenueClaim("mic", mic))
    if not identified.mic:
        return None
    return resolve_venue(None, provider_claim(exchange), VenueClaim("mic", mic)).mic


def shared_venue(*mics: str | None) -> str | None:
    """The one venue every MIC can describe, such as Nasdaq and one of its listing tiers."""
    from trading_max.research.venues import VenueClaim, resolve_venue

    if not mics or not all(mics):
        return None
    return resolve_venue(None, *(VenueClaim("mic", mic) for mic in mics)).mic


def local_venue_symbol(ticker: str, mic: str | None) -> str:
    """Remove only a quote-provider suffix that belongs to this venue."""
    from trading_max.research.venues import YAHOO_SUFFIX_BY_MIC

    ticker = ticker.strip().upper()
    suffix = YAHOO_SUFFIX_BY_MIC.get(mic)
    return ticker.removesuffix(suffix) if suffix and len(ticker) > len(suffix) else ticker
