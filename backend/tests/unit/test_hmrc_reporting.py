import io
from datetime import UTC, date, datetime, timedelta
from zipfile import ZipFile

import httpx
from trading_max.infrastructure.hmrc_reporting import (
    ATTACHMENT_ORIGIN,
    CONTENT_API,
    ODS,
    HMRCReportingSource,
    parse_reporting_ods,
    reporting_fund,
)

A = "ZZ0000000011"
B = "ZZ0000000022"
C = "ZZ0000000033"
D = "ZZ0000000044"
URL = ATTACHMENT_ORIGIN + "/media/example/register.ods"
NOW = datetime(2026, 11, 13, tzinfo=UTC)


def ods(rows):
    ns = "urn:oasis:names:tc:opendocument:xmlns:"
    xml = f'<office:document-content xmlns:office="{ns}office:1.0" xmlns:table="{ns}table:1.0" xmlns:text="{ns}text:1.0"><table:table>'
    for row in rows:
        xml += "<table:table-row>"
        for value in row:
            xml += f"<table:table-cell><text:p>{value}</text:p></table:table-cell>"
        xml += '<table:table-cell table:number-columns-repeated="16375"/></table:table-row>'
    xml += "</table:table></office:document-content>"
    payload = io.BytesIO()
    with ZipFile(payload, "w") as archive:
        archive.writestr("content.xml", xml)
    return payload.getvalue()


def test_reporting_register_exact_match_and_weekly_request_budget(tmp_path):
    calls = []
    failing = False

    def handle(req):
        calls.append(str(req.url))
        if failing:
            return httpx.Response(503)
        if str(req.url) == CONTENT_API:
            return httpx.Response(
                200,
                json={
                    "public_updated_at": "2026-11-11T00:00:00Z",
                    "details": {
                        "attachments": [
                            {
                                "content_type": ODS,
                                "title": "List of reporting funds A to Z",
                                "url": URL,
                            }
                        ]
                    },
                },
            )
        assert str(req.url) == URL
        return httpx.Response(
            200,
            content=ods(
                [
                    ("ISIN No", "Reporting Fund, with effect from", "Ceased to be an RF on"),
                    (A.lower(), "01/02/2022", ""),
                    (B, "2022-02-01", "2023-10-19"),
                    (C, "2027-01-01", ""),
                    (D, "31/02/2022", ""),
                    ("CUSIP-ONLY", "01/02/2022", ""),
                ]
            ),
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        source = HMRCReportingSource(tmp_path, client)
        register = source.refresh(NOW)
        assert calls == [CONTENT_API, URL]
        assert set(register.periods) == {A, B, C, D}
        approved = reporting_fund(register, A, NOW.date())
        assert approved.state == "reporting"
        assert approved.effective_from == date(2022, 2, 1)
        assert approved.evidence.fetched_at == NOW.isoformat()
        assert approved.evidence.source_url == URL
        assert reporting_fund(register, B, NOW.date()).ceased_on == date(2023, 10, 19)
        assert reporting_fund(register, B, NOW.date()).state == "ceased"
        assert reporting_fund(register, C, NOW.date()).state == "effective-later"
        assert reporting_fund(register, D, NOW.date()).state == "unavailable"
        assert reporting_fund(register, "ZZ0000000055", NOW.date()).state == "not-listed"
        assert reporting_fund(register, "no identifier", NOW.date()) is None
        assert source.refresh(NOW + timedelta(days=6)) == register
        assert calls == [CONTENT_API, URL]
        assert source.refresh(NOW + timedelta(days=7)) == register
        assert calls == [CONTENT_API, URL, CONTENT_API]
        failing = True
        assert source.refresh(NOW + timedelta(days=14)) == register
        assert source.refresh(NOW + timedelta(days=14, hours=12)) == register
        assert calls == [CONTENT_API, URL, CONTENT_API, CONTENT_API]


def test_hmrc_unsafe_attachment_never_requested(tmp_path):
    seen = []

    def handle(req):
        seen.append(str(req.url))
        return httpx.Response(
            200,
            json={
                "public_updated_at": "2026-11-11T00:00:00Z",
                "details": {
                    "attachments": [
                        {
                            "content_type": ODS,
                            "title": "List of reporting funds A to Z",
                            "url": "https://example.com/other.ods",
                        }
                    ]
                },
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert HMRCReportingSource(tmp_path, client).refresh(NOW) is None
    assert seen == [CONTENT_API]


def test_hmrc_schema_change_does_not_publish_empty_register():
    import pytest

    with pytest.raises(ValueError, match="schema changed or empty"):
        parse_reporting_ods(
            ods([("Ticker", "Effective date", "Other"), ("TEST", "2026-01-01", "")])
        )
