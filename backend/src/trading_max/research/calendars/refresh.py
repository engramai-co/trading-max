"""Conservatively refresh each publisher and retain its last successful schedule."""

import re
import ssl
from contextlib import contextmanager
from dataclasses import replace
from datetime import date, datetime, timedelta
from io import BytesIO

import httpx
from pypdf import PdfReader

from .catalog import HK_URL, sources
from .events import event, window_bounds
from .html import month, parse_html
from .structured import hk, ical, ons

MACRO_KEY = "research/macro_calendar.json"
MACRO_STATUS_KEY = "research/macro_calendar_status.json"
MAX_BYTES = 5 * 1024 * 1024
CALENDAR_HORIZON = 180
BOK_2027 = "https://www.bok.or.kr/fileSrc/eng/62fdd6164da24b79b80ac0579a767f4a/2/4940ab9c94de45a8948fe38c67923ae9.pdf"


@contextmanager
def official_reader():
    options = {
        "timeout": httpx.Timeout(12, connect=5),
        "headers": {
            "User-Agent": "Trading-Max-Calendar/1.0 (+https://github.com/engramai-co/trading-max)"
        },
    }
    with httpx.Client(**options) as client:

        def request(client, url):
            # The verified MPB attachment redirects to a short-lived URL on the bank’s file host.
            original = httpx.URL(url)
            target = original
            for _ in range(3):
                with client.stream("GET", target) as response:
                    if response.is_redirect and response.has_redirect_location:
                        target = target.join(response.headers["location"])
                        bok_file = original == httpx.URL(BOK_2027) and (
                            target.scheme,
                            target.host,
                            target.port,
                            target.path,
                        ) == (
                            "https",
                            "file-cdn.bok.or.kr",
                            None,
                            original.path.removeprefix("/fileSrc"),
                        )
                        if not bok_file and (target.scheme, target.host, target.port) != (
                            original.scheme,
                            original.host,
                            original.port,
                        ):
                            raise ValueError("unexpected calendar redirect")
                        continue
                    response.raise_for_status()
                    buffer = bytearray()
                    for chunk in response.iter_bytes(chunk_size=65536):
                        if len(buffer) + len(chunk) > MAX_BYTES:
                            raise ValueError("calendar size limit")
                        buffer.extend(chunk)
                    return bytes(buffer)
            raise ValueError("calendar redirect limit")

        def fetch(url):
            try:
                return request(client, url)
            except httpx.ConnectError as exc:
                cause = exc
                while cause is not None and not isinstance(cause, ssl.SSLCertVerificationError):
                    cause = cause.__cause__ or cause.__context__
                # C&SD resolves to rotating CDN addresses. Retry this specific
                # handshake failure once via fresh DNS, retaining normal SNI,
                # CA trust and hostname verification on the same official URL.
                if url != HK_URL or getattr(cause, "verify_code", None) != 62:
                    raise
                with httpx.Client(**options) as fresh:
                    return request(fresh, url)

        yield fetch


def parse(source, content, today):
    if source.parser == "bok_pdf":
        return _bok_rollover(source, content)
    if source.parser in {"ical", "ons", "hk"}:
        return list({"ical": ical, "ons": ons, "hk": hk}[source.parser](source, content, today))
    return parse_html(source, content)


def _bok_rollover(source, content):
    # The English table can lag behind the announced annual dates. The
    # publisher's 2027 announcement links this specific attachment.
    page = PdfReader(BytesIO(content)).pages[0].extract_text(extraction_mode="layout")
    if "meeting dates for 2027" not in " ".join(page.split()):
        raise ValueError("unrecognised MPB schedule")
    rows = [
        event(
            source,
            "Monetary Policy Board decision",
            "韩国央行货币政策决定",
            date(2027, month(m), int(d)),
            url=source.url,
        )
        for m, d in re.findall(
            r"(\b[A-Z][a-z]+)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\d{1,2})\b", page
        )
    ]
    if len(rows) != 8:
        raise ValueError("incomplete MPB schedule")
    return rows


def refresh_calendar(previous, now, fetch, *, catalog=sources):
    today = now.date()
    horizon = today + timedelta(days=CALENDAR_HORIZON)
    saved = {}

    def refresh(page):
        old = previous.get("sources", {}).get(page.key, {})
        if old.get("checked_at") and now - datetime.fromisoformat(old["checked_at"]) < timedelta(
            hours=20
        ):
            return old
        try:
            content = fetch(page.url)
            rows = parse(page, content, today)
            supplement = None
            archive = f"calendar-listview-{today.year}.html"
            if (
                page.key == "census"
                and archive.encode() in content
                and all(r.date.year != today.year for r in rows)
            ):
                supplement = page.url.replace("calendar-listview.html", archive)
            if (
                page.key == "bok"
                and today.year <= 2027 <= horizon.year
                and all(r.date.year != 2027 for r in rows)
            ):
                supplement = BOK_2027
            return {
                "publisher": page.publisher,
                "checked_at": now.isoformat(),
                "as_of": now.isoformat(),
                "error": None,
                "supplement": supplement,
                "events": [
                    r.model_dump(mode="json")
                    for r in rows
                    if page.parser == "ons"
                    or (
                        window_bounds(r.date, r.end_date)[1]
                        >= (today - timedelta(days=1)).isoformat()
                        and window_bounds(r.date, r.end_date)[0] <= horizon.isoformat()
                    )
                ],
            }
        except Exception as exc:
            return {
                **old,
                "publisher": page.publisher,
                "checked_at": now.isoformat(),
                "error": type(exc).__name__,
            }

    for source in catalog(today):
        saved[source.key] = refresh(source)
        # Secondary pages have their own clock; a missing annual attachment
        # cannot suppress the current year's successful official table.
        supplement = saved[source.key].get("supplement")
        if source.key == "bok" and supplement == BOK_2027:
            extra = replace(source, key="bok-2027", url=BOK_2027, parser="bok_pdf")
        elif source.key == "census" and supplement == source.url.replace(
            "calendar-listview.html", f"calendar-listview-{today.year}.html"
        ):
            extra = replace(source, key=f"census-{today.year}", url=supplement)
        else:
            continue
        saved[extra.key] = refresh(extra)
    return {"sources": saved, "window_start": today.isoformat(), "window_end": horizon.isoformat()}
