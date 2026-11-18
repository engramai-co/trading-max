"""Recorded publisher structures and synthetic ticker evidence; no live requests."""

import json
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from trading_max.research.calendars.catalog import sources
from trading_max.research.calendars.refresh import BOK_2027, parse, refresh_calendar
from trading_max.research.news import refresh_news

NOW = datetime(2026, 11, 18, 1, tzinfo=UTC)
FIXTURES = Path(__file__).parents[1] / "fixtures" / "calendars"
CATALOG = {s.key: s for s in sources(NOW.date())}


@pytest.mark.parametrize(
    ("key", "file", "title", "day", "clock"),
    [
        (
            "bea",
            "bea.ics",
            "GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026",
            "2026-11-25",
            "08:30",
        ),
        ("eurostat", "eurostat.ics", "Inflation (HICP)", "2026-11-18", None),
        (
            "census",
            "census.html",
            "Construction Spending (Construction Put in Place) (November 2026)",
            "2027-01-04",
            "10:00",
        ),
        ("fred-10", "fred.html", "Consumer Price Index", "2026-12-10", "07:30"),
        ("fomc", "fomc.html", "FOMC meeting", "2026-12-08", None),
        (
            "fedmonth-2026-december",
            "fedmonth.html",
            "FOMC policy announcement",
            "2026-12-09",
            "14:00",
        ),
        (
            "ons-upcoming",
            "ons-upcoming.json",
            "Consumer price inflation, UK: October 2026",
            "2026-11-18",
            "07:00",
        ),
        ("boe", "boe.html", "MPC policy decision and minutes", "2027-02-04", "12:00"),
        ("ecb", "ecb.html", "ECB monetary policy decision", "2026-12-17", "14:15"),
        (
            "ecbstats",
            "ecbstats.html",
            "Euro area seasonally adjusted HICP (Dataset: HICP)",
            "2026-11-18",
            "12:00",
        ),
        ("estat-cpi", "estat-cpi.html", "Tokyo CPI", "2026-11-27", "08:30"),
        ("estat-labour", "estat-labour.html", "Labour force survey", "2026-12-01", "08:30"),
        (
            "estat-output",
            "estat-output.html",
            "Industrial production (revised)",
            "2026-12-14",
            "13:30",
        ),
        ("cao", "cao.html", "GDP: Jul.-Sep. 2026 (The Second Preliminary)", "2026-12-08", "08:50"),
        ("boj", "boj.html", "Bank of Japan policy decision", "2026-12-18", None),
        ("hk", "hk.json", "Consumer Price Index for October 2026", "2026-11-20", None),
        ("mods", "mods.html", "Consumer prices", "2026-12-02", "08:00"),
        ("bok", "bok.html", "Monetary Policy Board decision", "2026-11-26", None),
    ],
)
def test_calendar_rows(key, file, title, day, clock):
    s = CATALOG[key]
    events = parse(s, (FIXTURES / file).read_bytes(), NOW.date())
    found = next(r for r in events if r.title_en == title and r.date.isoformat() == day)
    assert (found.instant.strftime("%H:%M") if found.instant else None) == clock
    assert found.title_zh and found.credit and found.source_url.startswith("https://")
    if key == "fomc":
        assert found.end_date == date(2026, 12, 9)
    if key in {"hk", "ons-upcoming"}:
        assert len(events) == 1
    if key == "estat-cpi":
        assert [(r.title_en, r.date.day) for r in events] == [
            ("National CPI", 20),
            ("Tokyo CPI", 27),
        ]


def test_revision_cancellation_retention_and_request_interval():
    s = CATALOG["ons-upcoming"]
    raw = json.loads((FIXTURES / "ons-upcoming.json").read_bytes())
    content = raw["releases"][1]["description"]

    def refresh(previous, now, body):
        return refresh_calendar(previous, now, lambda _: body, catalog=lambda _: [s])

    first = refresh({}, NOW, json.dumps(raw))
    assert refresh(first, NOW + timedelta(hours=1), b"invalid")["sources"] == first["sources"]
    content["release_date"] = "2026-11-23T07:00:00.000Z"
    moved = refresh(first, NOW + timedelta(days=2), json.dumps(raw))
    content["cancelled"] = True
    cancelled = refresh(moved, NOW + timedelta(days=3), json.dumps(raw))

    def row(result):
        return result["sources"][s.key]["events"][0]

    assert row(first)["id"] == row(moved)["id"] == row(cancelled)["id"]
    assert row(moved)["date"] == "2026-11-23"
    assert [r["status"] for r in cancelled["sources"][s.key]["events"]] == ["cancelled"]
    failed = refresh(cancelled, NOW + timedelta(days=4), b"<html>service unavailable</html>")
    assert row(failed) == row(cancelled)
    assert failed["sources"][s.key]["as_of"] == cancelled["sources"][s.key]["as_of"]
    assert failed["sources"][s.key]["error"]
    assert (
        parse(CATALOG["ons-cancelled"], (FIXTURES / "ons-cancelled.json").read_bytes(), NOW.date())[
            0
        ].status
        == "cancelled"
    )


def test_korean_annual_attachment_has_its_own_failure_clock():
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    block = DecodedStreamObject()
    lines = [
        "meeting dates for 2027",
        "January Thursday 14 July Thursday 15",
        "February Thursday 25 August Thursday 26",
        "April Friday 9 October Friday 15",
        "May Thursday 27 November Thursday 25",
    ]
    block.set_data(
        (
            "BT /F1 12 Tf 14 TL 40 700 Td " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
        ).encode()
    )
    page[NameObject("/Contents")] = writer._add_object(block)
    body = BytesIO()
    writer.write(body)
    s = CATALOG["bok"]

    def refresh(pdf):
        return refresh_calendar(
            {},
            NOW,
            lambda url: pdf if url == BOK_2027 else (FIXTURES / "bok.html").read_bytes(),
            catalog=lambda _: [s],
        )["sources"]

    good = refresh(body.getvalue())
    assert good["bok-2027"]["events"][0]["date"] == "2027-01-14"
    assert good["bok-2027"]["events"][0]["instant"] is None
    failed = refresh(b"bad pdf")
    assert failed["bok-2027"]["error"] and failed["bok"]["events"] == good["bok"]["events"]


def test_yahoo_budget_precision_retention_and_security_filter():
    calls = []

    class Budget:
        @contextmanager
        def yahoo_request(self):
            calls.append("reserved")
            yield

    story = {
        "content": {
            "id": "fixture-1",
            "title": "Synthetic headline",
            "pubDate": "2026-11-17T20:00:02.155Z",
            "provider": {"displayName": "Example Press"},
            "canonicalUrl": {"url": "https://example.org/story"},
            "summary": "body must stay private",
        }
    }
    first = refresh_news({}, ["TEST", "TEST"], NOW, Budget(), lambda _: [story, story])
    row = first["securities"]["TEST"]
    assert len(row["items"]) == 1 and row["items"][0]["instant"].endswith("02.155000+00:00")
    assert "summary" not in str(row) and calls == ["reserved"]
    assert refresh_news(first, ["TEST"], NOW + timedelta(hours=2), Budget(), lambda _: []) == first
    later = refresh_news(
        first, ["TEST"], NOW + timedelta(hours=8), Budget(), lambda _: [{"title": "undated"}]
    )
    assert later["securities"]["TEST"]["items"] == row["items"]
    assert later["securities"]["TEST"]["as_of"] == row["as_of"]
    assert later["securities"]["TEST"]["error"]
    cached = {
        "TEST": {
            "asOf": NOW.isoformat(),
            "news": [
                {
                    "title": "Cached headline",
                    "source": "Example Press",
                    "url": "https://example.org/a",
                    "publishedAt": NOW.isoformat(),
                }
            ],
        }
    }
    reused = refresh_news(
        {}, ["TEST"], NOW, Budget(), lambda _: pytest.fail("duplicate fetch"), financials=cached
    )
    assert (
        reused["securities"]["TEST"]["items"][0]["title"] == "Cached headline" and len(calls) == 2
    )
