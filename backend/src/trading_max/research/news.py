"""Store only Yahoo-compatible headline metadata for the requested listings."""

from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlsplit

import yfinance as yf

from trading_max.infrastructure.shared_market_prices import SharedMarketPrices

NEWS_KEY = "research/security_news.json"
NEWS_STATUS_KEY = "research/security_news_status.json"


def web_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parts = urlsplit(value)
        return (
            value
            if parts.scheme in {"http", "https"}
            and parts.hostname
            and not parts.username
            and not parts.password
            else None
        )
    except ValueError:
        return None


def verified_news(proxy):
    """Use yfinance's authenticated transport and inspect the original response.

    The pinned get_news() turns invalid JSON and missing streams into an empty
    list. Only an explicit successful ticker stream verifies zero articles.
    """
    response = proxy._data.post(
        "https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin",
        body={"serviceConfig": {"snippetCount": 20, "s": [proxy.ticker]}},
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors") or payload.get("error"):
        raise ValueError("Yahoo news error")
    feed = payload["data"]["tickerStream"]
    rows = feed["stream"]
    if (
        feed.get("error")
        or not isinstance(rows, list)
        or not all(isinstance(r, dict) for r in rows)
    ):
        raise ValueError("invalid Yahoo ticker stream")
    articles = [r for r in rows if not r.get("ad")]
    if articles and not any(headline(r) for r in articles):
        raise ValueError("unrecognised news records")
    return articles


def yahoo_news(ticker):
    return verified_news(yf.Ticker(ticker))


def headline(row):
    content = row.get("content") or row
    raw = content.get("pubDate") or content.get("providerPublishTime")
    title = content.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    try:
        instant = (
            datetime.fromtimestamp(raw, UTC)
            if isinstance(raw, int)
            else datetime.fromisoformat(raw)
        )
        day = instant.date().isoformat()
        # A publisher may supply only a local calendar date. Preserve that
        # precision without assigning a timezone to an unzoned wall clock.
        exact = instant.isoformat() if instant.utcoffset() is not None else None
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    link = (
        web_url((content.get("canonicalUrl") or {}).get("url"))
        or web_url(content.get("link"))
        or web_url((content.get("clickThroughUrl") or {}).get("url"))
    )
    publisher = (content.get("provider") or {}).get("displayName") or content.get("publisher")
    if not link or not isinstance(publisher, str) or not publisher.strip():
        return None
    return {
        "title": title.strip()[:320],
        "publisher": publisher[:160],
        "url": link,
        "date": day,
        "instant": exact,
        "id": str(content.get("id") or row.get("id") or row.get("uuid") or link)[:2048],
    }


def refresh_news(
    previous,
    tickers,
    now,
    budget: SharedMarketPrices,
    loader: Callable = yahoo_news,
    *,
    financials=None,
):
    # The scheduled universe contains the current research list and held
    # listings. Older publications keep their own universe and headline rows.
    saved = {}
    for ticker in dict.fromkeys(tickers):
        old = previous.get("securities", {}).get(ticker, {})
        if old.get("checked_at") and now - datetime.fromisoformat(old["checked_at"]) < timedelta(
            hours=6
        ):
            saved[ticker] = old
            continue
        try:
            evidence = (financials or {}).get(ticker, {})
            if (
                evidence.get("asOf")
                and now - datetime.fromisoformat(evidence["asOf"]) < timedelta(hours=6)
                and isinstance(evidence.get("news"), list)
                and evidence.get("status", {}).get("news", {}).get("state")
                in {"verified", "missing"}
            ):
                if (evidence.get("status", {}).get("news") or {}).get("state") == "missing":
                    raise ValueError("news fetch failed")
                observed = evidence["asOf"]
                rows = [
                    {
                        "uuid": r.get("id"),
                        "title": r.get("title"),
                        "publisher": r.get("source"),
                        "pubDate": r.get("publishedAt"),
                        "link": r.get("url"),
                    }
                    for r in evidence["news"]
                ]
            else:
                observed = now.isoformat()
                with budget.yahoo_request():
                    rows = loader(ticker)
            if not isinstance(rows, list):
                raise ValueError("invalid news payload")
            fresh = [h for row in rows[:20] if isinstance(row, dict) and (h := headline(row))]
            if rows and not fresh:
                raise ValueError("unrecognised news records")
            # A rolling latest-news page does not withdraw older headlines.
            by_url = {
                r["url"]: r
                for r in [*old.get("items", []), *fresh]
                if date.fromisoformat(r.get("date") or r["instant"][:10])
                >= now.date() - timedelta(days=365)
            }
            by_id = {h["id"]: h for h in by_url.values()}
            saved[ticker] = {
                "items": sorted(
                    by_id.values(),
                    key=lambda r: (
                        r.get("date") or r["instant"][:10],
                        datetime.fromisoformat(r["instant"]).astimezone(UTC).isoformat()
                        if r.get("instant")
                        else "",
                    ),
                    reverse=True,
                )[:500],
                "checked_at": now.isoformat(),
                "as_of": observed,
                "error": None,
            }
        except Exception as exc:
            saved[ticker] = {**old, "checked_at": now.isoformat(), "error": type(exc).__name__}
    return {"securities": saved}
