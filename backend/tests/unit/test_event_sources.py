"""Recorded publisher structures and synthetic ticker evidence; no live requests."""

import json
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

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
    found = next(
        r
        for r in events
        if (
            r.title_en == title
            or (key.startswith("estat-") and r.title_en.startswith(title + " ("))
        )
        and r.date.isoformat() == day
    )
    assert (found.instant.strftime("%H:%M") if found.instant else None) == clock
    assert found.title_zh and found.credit and found.source_url.startswith("https://")
    if key == "ecb":
        assert (
            found.time_source_url
            and events[0].date == date(2026, 12, 16)
            and events[0].end_date == found.date
        )
    if key == "fomc":
        assert found.end_date == date(2026, 12, 9)
    if key in {"hk", "ons-upcoming"}:
        assert len(events) == 1
    if key == "estat-cpi":
        assert [(r.title_en.split(" (")[0], r.date.day) for r in events] == [
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
    from trading_max.research.news import headline

    dated = headline({**story["content"], "pubDate": "2026-11-17"})
    assert dated["date"] == "2026-11-17" and dated["instant"] is None
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
            "status": {"news": {"state": "verified"}},
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


def test_scheduled_stages_publish_and_reuse_original_observation(tmp_path, monkeypatch):
    from trading_max.application import StageContext, TypedWorkerRuntime, event_stages
    from trading_max.research.news import NEWS_KEY

    from services.api.trading_max_api.typed_jobs import stage_plan

    scheduled = [name for name, _ in stage_plan("research", skip_sync=True, trigger="research")]
    live = [name for name, _ in stage_plan("live", skip_sync=False, trigger="live")]
    assert {"research.macro_calendar", "research.security_news"} <= set(scheduled) - set(live)
    runtime = TypedWorkerRuntime(tmp_path)
    source = CATALOG["bea"]
    content = (FIXTURES / "bea.ics").read_bytes()

    @contextmanager
    def fixture_reader():
        yield lambda _: content

    monkeypatch.setattr(event_stages, "official_reader", fixture_reader)
    monkeypatch.setattr(
        event_stages,
        "refresh_calendar",
        lambda last, now, read: refresh_calendar(last, NOW, read, catalog=lambda _: [source]),
    )

    class FixedClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    monkeypatch.setattr(event_stages, "datetime", FixedClock)
    finance = runtime.artifacts.put_json(
        key="research/financials.json",
        payload={
            "rows": [
                {
                    "ticker": "FIXTURE",
                    "financials": {
                        "evidence": {
                            "news": [],
                            "asOf": NOW.isoformat(),
                            "status": {"news": {"state": "verified"}},
                        }
                    },
                }
            ]
        },
    )
    context = StageContext(
        job_id="fixture",
        scope="research",
        trigger="research",
        tickers=("FIXTURE",),
        upstream_artifact_ids=(finance.ref.artifact_id,),
    )
    registry = runtime.registry()
    first = [
        ref
        for n in scheduled
        if n in {"research.macro_calendar", "research.security_news"}
        for ref in registry.get(n).run(context).artifacts
    ]
    assert len(first) == 4
    snapshot = runtime.snapshots.publish(
        scope="research", source="synthetic", artifacts=first, created_at=NOW
    )
    assert {ref.key for ref in snapshot.manifest.artifacts} == {
        event_stages.MACRO_KEY,
        NEWS_KEY,
        event_stages.MACRO_STATUS_KEY,
        event_stages.NEWS_STATUS_KEY,
    }
    assert all(ref.as_of == NOW.isoformat() for ref in first)
    news = registry.get("research.security_news").run(context)
    assert news.artifacts[0].artifact_id == next(r.artifact_id for r in first if r.key == NEWS_KEY)


def test_central_release_time_during_us_uk_clock_change_gap():
    raw = (FIXTURES / "fred.html").read_bytes().replace(b"December 10, 2026", b"March 19, 2026")
    (row,) = parse(CATALOG["fred-10"], raw, NOW.date())
    assert (
        row.instant.astimezone(ZoneInfo("Europe/London")).isoformat() == "2026-03-19T12:30:00+00:00"
    )


def test_ons_revised_time_provisional_month_and_licence():
    revised, month_only, provisional = parse(
        CATALOG["ons-upcoming"], (FIXTURES / "ons-precision.json").read_bytes(), NOW.date()
    )
    assert revised.instant.isoformat() == "2026-11-24T09:30:00+00:00"
    assert month_only.model_dump(mode="json")["date"] == "2026-12"
    assert month_only.instant is None
    assert provisional.status == "provisional"
    assert provisional.instant and provisional.instant.isoformat() == "2027-02-19T07:00:00+00:00"
    assert (
        revised.licence_url
        == "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
    )


@pytest.mark.parametrize("key", ["estat-cpi", "estat-labour"])
def test_estat_retains_period_and_stage_in_both_languages(key):
    rows = parse(CATALOG[key], (FIXTURES / (key + "-periods.html")).read_bytes(), NOW.date())
    assert len({r.title_en for r in rows}) == len({r.title_zh for r in rows}) == len(rows)
    assert any("annual" in r.title_en.lower() and "年平均" in r.title_zh for r in rows)
    if key == "estat-labour":
        assert any("detailed" in r.title_en.lower() and "详细" in r.title_zh for r in rows)


@pytest.mark.parametrize(
    ("code", "body"),
    [(503, "<html>Unavailable</html>"), (200, "{}"), (200, '{"data":{"tickerStream":{}}}')],
)
def test_yahoo_invalid_response_survives_disclosure_reuse_and_health(
    tmp_path, monkeypatch, code, body
):
    from contextlib import nullcontext
    from types import SimpleNamespace
    from unittest.mock import Mock

    import httpx
    from fastapi.testclient import TestClient
    from trading_max.application import StageContext, TypedWorkerRuntime, event_stages
    from trading_max.research import disclosures, news

    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings
    from services.api.trading_max_api.credentials import InMemoryCredentialStore

    response = httpx.Response(
        code, content=body, request=httpx.Request("POST", "https://finance.yahoo.com/xhr/ncp")
    )
    proxy = SimpleNamespace(ticker="FIX.L", _data=SimpleNamespace(post=lambda *a, **kw: response))
    monkeypatch.setattr(news.yf, "Ticker", lambda _: proxy)
    evidence = disclosures.ResearchEvidenceProvider(tmp_path / "disclosures")("FIX.L", {})
    assert evidence["status"]["news"]["state"] == "missing"
    observed = (NOW - timedelta(hours=8)).isoformat()
    story = {
        "id": "fixture",
        "date": "2026-11-17",
        "instant": None,
        "title": "Synthetic",
        "publisher": "Fixture",
        "url": "https://example.org/story",
    }
    prior = {"securities": {"FIX.L": {"checked_at": observed, "as_of": observed, "items": [story]}}}
    budget = SimpleNamespace(yahoo_request=nullcontext)
    for cache in (None, {"FIX.L": {**evidence, "asOf": NOW.isoformat()}}):
        row = news.refresh_news(prior, ["FIX.L"], NOW, budget, financials=cache)["securities"][
            "FIX.L"
        ]
        assert row["as_of"] == observed and row["items"] == [story] and row["error"]
    runtime = TypedWorkerRuntime(tmp_path)
    ref = runtime.artifacts.put_json(key=news.NEWS_KEY, payload=prior).ref
    runtime.snapshots.publish(scope="research", source="synthetic", artifacts=[ref])
    stage = runtime.registry().get("research.security_news")
    monkeypatch.setattr(event_stages, "datetime", Mock(now=lambda tz: NOW))
    result = stage.run(
        StageContext(job_id="fixture", scope="research", trigger="research", tickers=("FIX.L",))
    )
    runtime.snapshots.publish(scope="research", source="synthetic", artifacts=result.artifacts)
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        (health,) = client.get("/health").json()["eventRefreshes"]
    covered = {"FIX.L"} | {
        spec.symbol
        for spec in event_stages.INDEX_REGISTRY.values()
        if spec.symbol and spec.rights == "provider-terms"
    }
    assert health["failedSources"] == len(covered) and health["asOf"] == observed
    assert health["failures"][0]["source"] == "Yahoo Finance"
    assert "FIX.L" not in str(health)


@pytest.mark.parametrize("storage", ["legacy", "compressed", "chunked"])
def test_news_reuses_content_ref_when_only_refresh_time_changes(tmp_path, monkeypatch, storage):
    from unittest.mock import Mock

    from trading_max.application import StageContext, TypedWorkerRuntime, event_stages
    from trading_max.research.news import NEWS_KEY

    monkeypatch.setenv("TRADING_MAX_ARTIFACT_STORAGE", storage)
    runtime = TypedWorkerRuntime(tmp_path)
    assert runtime.artifacts.storage_mode == storage
    stage = runtime.registry().get("research.security_news")
    context = StageContext(
        job_id="fixture", scope="research", trigger="research", tickers=("TEST",)
    )
    clock = NOW

    def refresh(prior, context, now):
        return {
            "securities": {
                f"FIX{n}": {
                    "items": [
                        {"id": f"article-{n}-{i}", "title": f"Synthetic observation {n}-{i}"}
                        for i in range(500)
                    ],
                    "checked_at": clock.isoformat(),
                    "as_of": clock.isoformat(),
                    "error": None,
                }
                for n in range(100)
            }
        }

    monkeypatch.setattr(event_stages, "datetime", Mock(now=lambda zone: clock))
    monkeypatch.setattr(stage, "refresh", refresh)
    first = stage.run(context).artifacts
    runtime.snapshots.publish(scope="research", source="synthetic", artifacts=first)
    clock += timedelta(hours=8)
    second = stage.run(context).artifacts
    old = {r.key: r.artifact_id for r in first}
    new = {r.key: r.artifact_id for r in second}
    assert new[NEWS_KEY] == old[NEWS_KEY]
    assert {k for k in new if old[k] != new[k]} == {"research/security_news_status.json"}


def test_hk_reconnect_still_requires_valid_hostname(monkeypatch):
    import ssl

    import httpx
    from trading_max.research.calendars import refresh as module

    responses = [False, True, False, False]
    attempts = []

    class StrictClient:
        def __init__(self, **kwargs):
            assert kwargs.get("verify", True) is True

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        @contextmanager
        def stream(self, method, url):
            assert url == httpx.URL(CATALOG["hk"].url)
            attempts.append(url.host)
            if not responses.pop(0):
                exc = ssl.SSLCertVerificationError(1, "hostname mismatch")
                exc.verify_code = 62
                raise httpx.ConnectError("TLS verification failed") from exc
            yield httpx.Response(
                200, request=httpx.Request(method, url), content=(FIXTURES / "hk.json").read_bytes()
            )

    monkeypatch.setattr(module.httpx, "Client", StrictClient)
    with module.official_reader() as fetch:
        assert parse(CATALOG["hk"], fetch(CATALOG["hk"].url), NOW.date())
        with pytest.raises(httpx.ConnectError):
            fetch(CATALOG["hk"].url)
    assert attempts == ["www.censtatd.gov.hk"] * 4


def test_verified_empty_stream_and_unverified_legacy_disclosure_cache(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    import httpx
    from trading_max.research import news

    calls = []

    def post(url, body):
        calls.append((url, body))
        return httpx.Response(
            200, json={"data": {"tickerStream": {"stream": []}}}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(
        news.yf, "Ticker", lambda t: SimpleNamespace(ticker=t, _data=SimpleNamespace(post=post))
    )
    cache = {"asOf": NOW.isoformat(), "news": [], "status": {}}
    result = news.refresh_news(
        {}, ["TEST"], NOW, SimpleNamespace(yahoo_request=nullcontext), financials={"TEST": cache}
    )
    assert (
        result["securities"]["TEST"]["as_of"] == NOW.isoformat()
        and not result["securities"]["TEST"]["error"]
    )
    assert len(calls) == 1 and calls[0][1]["serviceConfig"]["s"] == ["TEST"]
