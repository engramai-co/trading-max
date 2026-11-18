"""Parsers for the two official iCalendars and the ONS and Hong Kong JSON indexes."""

import json
import re
from datetime import date, datetime, timedelta
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

from .events import event, family


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
        # Provisional midnight dates are placeholders, and withdrawn releases
        # have no promised clock.
        clock = (
            local.time()
            if status == "finalised" and local.time().isoformat() != "00:00:00"
            else None
        )
        yield event(
            source,
            title,
            zh,
            local.date(),
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
