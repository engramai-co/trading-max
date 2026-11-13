"""Synthetic issuer disclosures for one-year ETF tracking."""

from datetime import date
from io import BytesIO

import httpx
import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from trading_max.analytics.etf_projection import tracking
from trading_max.analytics.lookthrough import FundHolding
from trading_max.infrastructure.fund_holdings import (
    HSBC_FACTSHEET_URL,
    HSBC_HOLDINGS_URL,
    fetch_official_snapshot,
)
from trading_max.infrastructure.fund_profiles import parse_hsbc_profile, parse_invesco_profile
from trading_max.infrastructure.fund_specs import FundSpec

ISIN = "IE0000000001"
STAMP = "2026-10-31"
TODAY = date(2026, 11, 13)
HEADER = "Monthly report 31 October 2026 | FIXT LN | USD (Acc)"
COVER = f"""Marketing communication | {HEADER}
Share class base currency USD
Fund base currency USD
ISIN {ISIN}"""
PERFORMANCE = f"""{HEADER}
The figures are calculated in the share class base currency, dividend reinvested, net
of fees.
Source: HSBC Asset Management, data as at 31 October 2026
Performance (%) YTD 1 month 3 months 6 months 1 year
Fund 1.00 2.00 3.00 4.00 12.30
Reference Benchmark 1.00 2.00 3.00 4.00 12.10
Rolling performance (%)
31/10/25-
31/10/26
31/10/24-
31/10/25
Fund 12.30 -3.45
Reference Benchmark 12.10 -3.25
Benchmark information
Index name 100% MSCI Emerging Markets Net
Index currency USD
Benchmark type Total Return
TR Index Bloomberg Ticker NDUEEGF
Sector allocation (%)
Industrials
100.00"""


def _synthetic_pdf(*pages: str) -> bytes:
    writer = PdfWriter()
    for page_text in pages:
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
            }
        )
        lines = []
        for line in page_text.splitlines():
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            lines.append(f"({escaped}) Tj T*")
        content = DecodedStreamObject()
        content.set_data(("BT /F1 9 Tf 12 TL 42 750 Td\n" + "\n".join(lines) + "\nET").encode())
        page[NameObject("/Contents")] = content
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_hsbc_reuses_factsheet_for_tracking_and_sectors(monkeypatch):
    spec = FundSpec("FIXT", ISIN, "Fixture", "HSBC Asset Management", "https://issuer.example/fund")
    responses = {
        HSBC_HOLDINGS_URL: b"synthetic workbook",
        HSBC_FACTSHEET_URL: _synthetic_pdf(COVER, PERFORMANCE),
    }
    requests = []

    def handler(request):
        url = str(request.url)
        requests.append(url)
        return httpx.Response(200, content=responses[url])

    def parse_workbook(content):
        assert content == responses[HSBC_HOLDINGS_URL]
        return [FundHolding(name="Fixture", weight_pct=100)], {"Fixture market": 100}, "2026-11-12"

    monkeypatch.setattr(
        "trading_max.infrastructure.fund_holdings._parse_hsbc_workbook", parse_workbook
    )
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        snapshot = fetch_official_snapshot(spec.ticker, spec=spec, client=client)
    assert requests == [HSBC_HOLDINGS_URL, HSBC_FACTSHEET_URL]
    assert snapshot.as_of == "2026-11-12"
    assert snapshot.industry_weights == {"Industrials": 100}
    reading = tracking(snapshot.profile, TODAY)
    assert reading.state == "available"
    assert reading.difference_pp == pytest.approx(0.20)
    assert reading.period_end == reading.evidence.effective_at == STAMP
    assert reading.currency == reading.benchmark_currency == "USD"
    assert reading.nav_hedging == reading.benchmark_hedging == "unhedged"
    assert reading.evidence.source_url == HSBC_FACTSHEET_URL
    assert reading.evidence.parser_version == "hsbc-facts-v1"
    assert reading.evidence.coverage == "available"


@pytest.mark.parametrize(
    ("cover", "performance"),
    [
        (COVER, PERFORMANCE.replace("Reference Benchmark 12.10", "Reference Benchmark --")),
        (COVER, PERFORMANCE.replace("31/10/25-\n31/10/26", "30/09/25-\n31/10/26")),
        (COVER, PERFORMANCE.replace("31/10/25-\n31/10/26", "30/09/25-\n30/09/26")),
        (COVER, PERFORMANCE.replace("Index currency USD", "")),
        (COVER, PERFORMANCE.replace("Benchmark type Total Return", "Benchmark type Price Return")),
        (COVER.replace(ISIN, "IE0000000002"), PERFORMANCE),
    ],
)
def test_hsbc_leaves_incomplete_or_unverified_pair_missing(cover, performance):
    profile = parse_hsbc_profile([cover, performance], ISIN, "Fixture", HSBC_FACTSHEET_URL)
    reading = tracking(profile, TODAY)
    assert reading.state == "missing"
    assert reading.difference_pp is None
    assert reading.evidence.source_url == HSBC_FACTSHEET_URL
    assert reading.evidence.coverage == "missing"


@pytest.mark.parametrize(
    ("cover", "performance", "currency", "hedging"),
    [
        (COVER, PERFORMANCE.replace("Index currency USD", "Index currency GBP"), "GBP", "unhedged"),
        (
            COVER.replace("USD (Acc)", "USD Hedged (Acc)"),
            PERFORMANCE.replace("USD (Acc)", "USD Hedged (Acc)"),
            "USD",
            "USD",
        ),
    ],
)
def test_hsbc_exposes_mismatched_currency_or_hedging_without_a_number(
    cover, performance, currency, hedging
):
    profile = parse_hsbc_profile([cover, performance], ISIN, "Fixture", HSBC_FACTSHEET_URL)
    reading = tracking(profile, TODAY)
    assert reading.state == "incomparable"
    assert reading.difference_pp is None
    assert reading.period_end == STAMP
    assert reading.benchmark_currency == currency
    assert reading.nav_hedging == hedging


def test_invesco_api_only_documents_an_unhedged_benchmark_for_gbp_hedged_class():
    profile = parse_invesco_profile(
        {
            "aliases": {"isin": ISIN},
            "shareClassCurrency": "GBP",
            "hedgedIndicator": True,
            "hedgedCurrencyCode": "GBP",
            "benchmarkRelationships": [
                {"benchmarkFullName": "Fixture Notional NTR Index", "baseCurrency": "USD"},
            ],
        },
        ISIN,
        "https://issuer.example/shareclass",
    )
    reading = tracking(profile, TODAY)
    assert reading.state == "incomparable"
    assert reading.difference_pp is None
    assert reading.currency == reading.nav_hedging == "GBP"
    assert reading.benchmark_currency == "USD"
    assert reading.benchmark_hedging == "unhedged"
