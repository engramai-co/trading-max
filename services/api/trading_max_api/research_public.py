"""Read-only quote and technical lenses for a verified public listing."""

import logging
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pandas as pd
from trading_max.research.calendar import session_schedule
from trading_max.research.facts import ResearchCapability, ResearchContext, make_quote
from trading_max.research.fund_references import us_fund
from trading_max.research.technical import analyze_ticker
from trading_max.research.venues import (
    VenueConflict,
    provider_claim,
    resolve_venue,
    watchlist_claims,
)

from .dashboard_models import ResearchLensName, ResearchLensSnapshot
from .models import SecuritySearchResult, SnapshotManifest
from .projections.research import technical_rows
from .research import _technical_summary
from .research_prices import SecurityPriceHistory

LOGGER = logging.getLogger(__name__)


def public_lens(
    security: SecuritySearchResult,
    view: ResearchLensName,
    detail: str,
    manifest: SnapshotManifest,
    price_reader: SecurityPriceHistory,
) -> ResearchLensSnapshot:
    """Build a transient view without modifying the watchlist or a published run."""
    ticker = security.ticker
    is_fund = (security.security_type or "").upper() in {"ETF", "ETP", "MUTUALFUND"}
    reference = us_fund(ticker)
    asset_type = "ETF" if is_fund or reference else "EQUITY"
    market = {}
    metrics = {"fullExchangeName": security.exchange, "quoteType": asset_type}
    technical = None
    claims = list(
        watchlist_claims(
            ticker, security.exchange, security.bloomberg_ticker, security.exchange_source
        )
    )
    if reference:
        claims.append(provider_claim(reference.exchange, ticker))
    venue = resolve_venue(ticker, *claims)
    if view in {"overview", "technical"} and not venue.conflict:
        try:
            series = (
                price_reader.alpaca_etf(ticker, "1d") if reference else None
            ) or price_reader.get(ticker, "1d", market_etf=True)
            venue = resolve_venue(ticker, *claims, *series.venue_claims)
            if venue.conflict:
                raise VenueConflict("public quote belongs to another venue")
            frame = pd.DataFrame(
                {
                    "Close": [row.close for row in series.points],
                    "Open": [row.open for row in series.points],
                    "High": [row.high for row in series.points],
                    "Low": [row.low for row in series.points],
                    "Volume": [row.volume for row in series.points],
                },
                index=pd.DatetimeIndex(
                    [row.date[:10] for row in series.points],
                    tz=ZoneInfo(series.timezone or "UTC"),
                ),
            ).astype(float)
            frame.attrs.update(asset_type=asset_type, exchange=series.exchange_calendar)
            artifact = analyze_ticker(
                ticker, ticker, frame, {}, currency=series.currency, requested_period="10y"
            )
            market = {
                "ticker": ticker,
                "spot": artifact.price,
                "asOf": artifact.as_of,
                "currency": series.currency,
            }
            if series.timezone:
                metrics["exchangeTimezoneName"] = series.timezone
            technical = technical_rows({"rows": [artifact.model_dump(by_alias=False)]})[0]
        except Exception:
            # The verified listing remains readable when the market source fails.
            LOGGER.debug("Public listing history unavailable")
    fundamental = {"metrics": metrics}
    quote = make_quote(ticker, market, fundamental, venue=venue)
    quote.schedule = session_schedule(venue.calendar, datetime.now(UTC))
    summary = view == "overview" and detail == "summary"
    return ResearchLensSnapshot(
        ticker=ticker,
        view=view,
        run_id=manifest.run_id,
        generated_at=manifest.created_at.isoformat(),
        market=market or None,
        technical=technical if not summary else None,
        technical_summary=_technical_summary(technical) if summary else None,
        fundamentals=fundamental if view in {"overview", "fundamentals"} else None,
        context=ResearchContext(
            quote=quote,
            asset_type=asset_type,
            datasets=[],
            capabilities=[
                ResearchCapability(task="overview", state="available"),
                ResearchCapability(
                    task="technical",
                    state="available" if technical is not None else "missing",
                    intervals=["1d"],
                ),
                ResearchCapability(
                    task="fundamentals", state="available" if asset_type == "ETF" else "missing"
                ),
            ],
        ),
    )
