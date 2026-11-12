import pytest
from trading_max.research.disclosures import link_filing_periods, match_periods, parse_filing


def test_parsed_filing_is_reused_across_provider_instances(tmp_path, monkeypatch):
    from trading_max.research.disclosures import ResearchEvidenceProvider

    record = {
        "type": "10-K",
        "date": "2025-10-31",
        "exhibits": {"10-K": "https://www.sec.gov/test"},
    }
    provider = ResearchEvidenceProvider(tmp_path)
    monkeypatch.setattr(provider, "_document", lambda url: filing())
    expected = provider._filing(record)
    fresh = ResearchEvidenceProvider(tmp_path)

    def unexpected(url):
        raise AssertionError("immutable parsed filing should be reused")

    monkeypatch.setattr(fresh, "_document", unexpected)
    assert fresh._filing(record) == expected
    assert expected["segments"][0]["value"] == 600_000_000


def test_filing_concurrency_is_bounded_ordered_and_keeps_failures(tmp_path, monkeypatch):
    from threading import Barrier, Lock

    from trading_max.research.disclosures import ResearchEvidenceProvider

    provider = ResearchEvidenceProvider(tmp_path)
    barrier, lock = Barrier(3), Lock()
    active = 0
    peak = 0

    def read(record):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(active, peak)
        barrier.wait(timeout=5)
        with lock:
            active -= 1
        if record["id"] == 2:
            raise ValueError("synthetic unavailable filing")
        return record

    monkeypatch.setattr(provider, "_filing", read)
    result = provider._filings([{"id": i} for i in range(6)])
    assert peak == 3
    assert isinstance(result[2], ValueError)
    assert [item["id"] for item in result if isinstance(item, dict)] == [0, 1, 3, 4, 5]


def filing():
    return """<html><xbrli:context id="all"><xbrli:period><xbrli:startDate>2024-09-29</xbrli:startDate><xbrli:endDate>2025-09-27</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="software"><xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:ProductOrServiceAxis">test:SoftwareMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2024-09-29</xbrli:startDate><xbrli:endDate>2025-09-27</xbrli:endDate></xbrli:period></xbrli:context>
    <ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-09-27</ix:nonNumeric>
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="all" unitRef="usd" scale="6">1,000</ix:nonFraction>
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="software" unitRef="usd" scale="6"><span>600</span><ix:exclude>note 17</ix:exclude></ix:nonFraction></html>"""


def test_segment_and_reported_period_come_from_the_same_filing():
    result = parse_filing(
        filing(), url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
    )
    assert result["periods"][0]["actualEnd"] == "2025-09-27"
    assert result["segments"][0]["value"] == 600_000_000
    assert result["segments"][0]["share"] == 0.6
    assert result["segments"][0]["dimension"] == "business"
    assert result["segments"][0]["name"] == "Software"
    matched = match_periods(
        {"incomeStatement": [{"index": "Total Revenue", "2025-09-30": 1e9}]}, result["periods"]
    )
    assert matched[0]["providerEnd"] == "2025-09-30"
    assert matched[0]["actualEnd"] == "2025-09-27"


def test_unknown_dimensions_do_not_become_business_segments():
    text = filing().replace(
        "ProductOrServiceAxis", "ShareBasedCompensationArrangementByShareBasedPaymentAwardAxis"
    )
    result = parse_filing(
        text, url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
    )
    assert not result["segments"]


def test_human_formatted_dei_date_and_context_only_annual_date():
    text = filing().replace(
        'name="dei:DocumentPeriodEndDate">2025-09-27',
        'name="dei:DocumentPeriodEndDate" format="ixt:date-monthname-day-year-en">September\u00a027, 2025',
    )
    result = parse_filing(
        text, url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
    )
    assert result["periodEnd"] == "2025-09-27"
    text = (
        filing()
        .replace('<ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-09-27</ix:nonNumeric>', "")
        .replace(
            'name="dei:DocumentFiscalYearFocus"',
            'name="dei:DocumentFiscalYearFocus" contextRef="all"',
        )
    )
    assert (
        parse_filing(
            text, url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
        )["periodEnd"]
        == "2025-09-27"
    )


def test_missing_currency_is_not_assumed_usd():
    text = filing().replace('unitRef="usd"', 'unitRef="unknown"')
    result = parse_filing(
        text, url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
    )
    assert result["segments"][0]["currency"] is None


@pytest.mark.parametrize("nil_value", ["true", "1"])
def test_nil_filing_fact_is_unavailable_instead_of_a_reported_zero(nil_value):
    text = filing().replace(
        'contextRef="all" unitRef="usd" scale="6">1,000',
        f'contextRef="all" unitRef="usd" scale="6" xsi:nil="{nil_value}">—',
    )
    result = parse_filing(
        text, url="https://example.test/report.htm", filed_at="2025-10-31", form="10-K"
    )
    assert result["observations"] == []
    assert result["segments"][0]["reportedTotal"] is None
    assert result["segments"][0]["share"] is None


def test_amendment_links_require_a_verified_matching_report_period():
    filings = [
        {
            "id": "original",
            "url": "https://example.test/original",
            "date": "2025-10-31",
            "form": "10-K",
            "documents": {"10-K": "original.htm"},
        },
        {
            "id": "amended",
            "url": "https://example.test/amended",
            "date": "2025-11-05",
            "form": "10-K/A",
            "amendment": True,
            "documents": {"10-K/A": "amended.htm"},
        },
        {
            "id": "unknown",
            "url": "https://example.test/unknown",
            "date": "2025-11-06",
            "form": "10-K/A",
            "amendment": True,
            "documents": {},
        },
    ]
    releases = [
        parse_filing(filing(), url=url, filed_at="2025-10-31", form="10-K")
        for url in ("original.htm", "amended.htm")
    ]
    rows = link_filing_periods(filings, releases)
    assert rows[0]["periodEnd"] == "2025-09-27"
    assert rows[1]["amendsId"] == "original"
    assert rows[0]["amendments"][0]["id"] == "amended"
    assert "amendsId" not in rows[2]
    assert "amendments" not in filings[0]


@pytest.mark.parametrize(
    ("ticker", "exchange", "expect_series"),
    [
        ("SYNT", "NMS", True),
        ("SYNT.L", "LSE", False),
    ],
)
def test_trailing_pe_is_published_from_completed_us_closes_and_reused(
    tmp_path, monkeypatch, ticker, exchange, expect_series
):
    from datetime import UTC, date, datetime

    import pandas as pd
    from trading_max.research import disclosures
    from trading_max.research.fundamentals import YFinanceResearchService
    from trading_max.research.trailing_pe import DilutedEps, EpsFiling

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2024, 2, 9, 19, tzinfo=tz)

    class Yahoo:
        news = ()

        def get_sec_filings(self):
            raise ValueError("synthetic Yahoo filing feed unavailable")

        def history(self, *, period, auto_adjust, actions):
            calls.append("history")
            assert (period, auto_adjust, actions) == ("10y", False, True)
            return pd.DataFrame(
                {"Close": [40, 50], "Stock Splits": [0, 0]},
                index=pd.to_datetime(["2024-02-08", "2024-02-09"]),
            )

        def get_history_metadata(self):
            return {
                "exchangeName": exchange,
                "currency": "USD",
                "instrumentType": "EQUITY",
            }

        def get_dividends(self, **kwargs):
            return pd.Series(dtype=float)

    def sec(symbol, *, since):
        calls.append("SEC")
        assert (symbol, since) == ("SYNT", date(2024, 2, 8))
        end = date(2023, 12, 31)
        return [
            EpsFiling(
                datetime(2024, 2, 8, 18, tzinfo=UTC),
                end,
                True,
                (DilutedEps(date(2023, 1, 1), end, 4),),
            )
        ]

    calls = []
    monkeypatch.setattr(disclosures, "datetime", Clock)
    monkeypatch.setattr(disclosures.yf, "Ticker", lambda symbol: Yahoo())
    provider = disclosures.ResearchEvidenceProvider(tmp_path)
    monkeypatch.setattr(provider.sec, "filings", sec)
    service = YFinanceResearchService(financials_loader=lambda ticker: {}, evidence_loader=provider)
    first = service.financials([ticker]).rows[0]
    second = service.financials([ticker]).rows[0]
    assert first == second
    assert "trailingPeHistory" not in first["financials"]["evidence"]
    if expect_series:
        assert calls == ["history", "SEC"]
        assert first["trailingPeHistory"]["points"] == [
            {"date": "2024-02-08", "close": 40, "pe": 10, "earningsIndex": 0}
        ]
    else:
        assert not calls
        assert "trailingPeHistory" not in first


def test_edgar_filing_declares_contact_user_agent(tmp_path, monkeypatch):
    import httpx
    from trading_max.research.disclosures import ResearchEvidenceProvider

    def get(url, *, timeout, headers):
        request = httpx.Request("GET", url, headers=headers)
        assert request.headers["User-Agent"] == "Trading Max contact@engramai.co"
        return httpx.Response(200, request=request, text=filing())

    monkeypatch.setattr(httpx, "get", get)
    assert (
        ResearchEvidenceProvider(tmp_path)._document("https://www.sec.gov/example.htm") == filing()
    )
