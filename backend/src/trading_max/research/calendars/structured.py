"""Parsers for the two official iCalendars and the ONS and Hong Kong JSON indexes."""

import json
import re
from datetime import date, datetime, time, timedelta
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

from .events import event, family
from .html import clock as parse_clock
from .html import month as month_number


def ical(source, content, today):
    text = re.sub(r"\r?\n[ \t]", "", content.decode("utf-8-sig"))
    if "BEGIN:VCALENDAR" not in text or "END:VCALENDAR" not in text:
        raise ValueError("invalid iCalendar")
    blocks = re.findall(r"BEGIN:VEVENT\s*(.*?)\s*END:VEVENT", text, flags=re.S)
    if not blocks:
        raise ValueError("empty iCalendar")
    # Next week becomes confirmed on Friday in Luxembourg.
    confirmed_to = today + timedelta(
        days=(6 - today.weekday()) + (7 if today.weekday() >= 4 else 0)
    )
    for block in blocks:
        fields = {}
        for line in block.splitlines():
            name, _, value = line.partition(":")
            fields[name.split(";")[0]] = value
        title = fields["SUMMARY"].replace(r"\,", ",").replace(r"\;", ";")
        zh = family(title)
        if not zh:
            continue
        raw = fields["DTSTART"]
        clock = None
        if source.key == "eurostat":
            # Published all-day dates have no release time. Export UIDs change
            # between downloads, so they cannot identify revisions.
            day = date.fromisoformat(raw)
            status = "provisional" if day > confirmed_to else "finalised"
            identity = None
        else:
            instant = datetime.fromisoformat(raw)
            if instant.utcoffset() is None:
                raise ValueError("missing release timezone")
            local = instant.astimezone(ZoneInfo(source.zone))
            day, clock = local.date(), local.time()
            identity = fields.get("UID")
            status = "finalised"
        if fields.get("STATUS") == "CANCELLED":
            status = "cancelled"
        elif fields.get("STATUS") == "TENTATIVE":
            status = "provisional"
        yield event(source, title, zh, day, clock=clock, status=status, identity=identity)


def _ons_provisional(value):
    """Read the human-published range, which can be less precise than the index."""
    exact = re.fullmatch(r"(\d{1,2}) ([A-Za-z]+) (\d{4})(?: (\d{1,2}:\d{2}[ap]m))?", value, re.I)
    if exact:
        return (
            date(int(exact[3]), month_number(exact[2]), int(exact[1])),
            None,
            parse_clock(exact[4] or ""),
        )
    months = re.fullmatch(r"([A-Za-z]+)(?: (\d{4}))?(?: to ([A-Za-z]+))? (\d{4})", value)
    if months:

        def month(name, year):
            return f"{year}-{month_number(name):02d}"

        return (
            month(months[1], months[2] or months[4]),
            month(months[3], months[4]) if months[3] else None,
            None,
        )
    raise ValueError("unrecognised provisional ONS date")


def ons(source, content, today):
    releases = json.loads(content)["releases"]
    if not isinstance(releases, list) or len(releases) >= 1000:
        raise ValueError("invalid or truncated release index")
    for row in releases:
        d = row["description"]
        title, path = d["title"], row["uri"]
        zh = family(title)
        if not zh or "time series" in title.lower() or not path.startswith("/releases/"):
            continue
        instant = datetime.fromisoformat(d["release_date"])
        if instant.utcoffset() is None:
            raise ValueError("missing ONS offset")
        local = instant.astimezone(ZoneInfo(source.zone))
        status = (
            "cancelled"
            if d.get("cancelled")
            else "postponed"
            if d.get("postponed")
            else "finalised"
            if d.get("finalised")
            else "provisional"
        )
        day, end = local.date(), None
        # The index publishes clocks for provisional and revised dates too.
        clock = (
            local.time()
            if not d.get("cancelled") and time.min not in (local.time(), instant.time())
            else None
        )
        if not d.get("finalised") and d.get("provisional_date"):
            day, end, clock = _ons_provisional(d["provisional_date"].strip())
        yield event(
            source,
            title,
            zh,
            day,
            end=end,
            clock=clock,
            status=status,
            identity=path,
            url=urljoin("https://www.ons.gov.uk", path),
        )


def hk(source, content, today):
    rows = json.loads(content)["press_release"]
    if not isinstance(rows, list) or not rows:
        raise ValueError("invalid press release index")
    for row in rows:
        if row["status"] != "1" or row["hide_date"] != "0":
            continue
        title = row["title"]
        if zh := family(title):
            yield event(
                source,
                title,
                zh,
                date.fromisoformat(row["startTime"][:10]),
                identity=row["PressReleaseID"],
            )
