"""Issuer-evidenced ETF benchmark assignments. Join on share-class ISIN."""

from datetime import date
from typing import Literal

from trading_max.domain.contracts import DomainModel

BenchmarkRelation = Literal[
    "exact",
    "same-family-other-variant",
    "similar-exposure",
    "related-different-structure",
    "unconfirmed",
]


class FundBenchmark(DomainModel):
    isin: str
    ticker: str
    benchmark_id: str
    relation: BenchmarkRelation
    comparison_id: str | None = None
    evidence_url: str
    evidence_date: date
    share_currency: str = "USD"
    hedged: bool = False
    domicile: Literal["IE", "US"] = "IE"


def _entry(
    isin: str,
    ticker: str,
    index: str,
    url: str,
    *,
    relation: BenchmarkRelation = "exact",
    comparison: str | None = None,
    hedged: bool = False,
) -> FundBenchmark:
    return FundBenchmark(
        isin=isin,
        ticker=ticker,
        benchmark_id=index,
        relation=relation,
        comparison_id=comparison,
        evidence_url=url,
        evidence_date=date(2026, 11, 15),
        share_currency="GBP" if hedged else "USD",
        hedged=hedged,
        domicile="US" if isin.startswith("US") else "IE",
    )


FUND_BENCHMARKS = {
    row.isin: row
    for row in (
        _entry(
            "IE00BYVTMW98",
            "EQGB",
            "nasdaq-100-nr",
            "https://www.invesco.com/content/dam/invesco/uk/en/product-documents/etf/share-class/factsheet/IE00BYVTMW98_factsheet_en-uk.pdf",
            relation="unconfirmed",
            comparison="nasdaq-100",
            hedged=True,
        ),
        _entry(
            "IE0032077012",
            "EQQQ",
            "nasdaq-100-nr",
            "https://www.invesco.com/content/dam/invesco/uk/en/product-documents/etf/share-class/factsheet/IE0032077012_factsheet_en-uk.pdf",
        ),
        _entry(
            "IE00BD1F4N50",
            "IUMF",
            "msci-usa-momentum",
            "https://www.ishares.com/gls-download/literature/fact-sheet/iumo-ishares-edge-msci-usa-momentum-factor-ucits-etf-fund-fact-sheet-en-gb.pdf",
        ),
        _entry(
            "IE000R4ZNTN3",
            "XUSE",
            "msci-world-ex-usa-nr",
            "https://www.ishares.com/uk/individual/en/products/340748/",
        ),
        _entry(
            "IE000KCS7J59",
            "HEMC",
            "msci-em-nr",
            "https://www.assetmanagement.hsbc.lu/api/v1/download/document/ie000kcs7j59/lu/en/factsheet",
        ),
        _entry(
            "IE00BMC38736",
            "SMGB",
            "marketvector-semiconductor-screened",
            "https://www.vaneck.com/uk/en/library/fact-sheets/smh-fact-sheet.pdf",
        ),
        _entry(
            "IE000I8KRLL9",
            "SEMI",
            "msci-semiconductors-screened",
            "https://www.ishares.com/uk/individual/en/products/319084/",
        ),
        _entry(
            "US46090E1038",
            "QQQ",
            "nasdaq-100-gr",
            "https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf",
            relation="same-family-other-variant",
            comparison="nasdaq-100-nr",
        ),
        _entry(
            "US46138G6492",
            "QQQM",
            "nasdaq-100-gr",
            "https://www.invesco.com/us/en/financial-products/etfs/invesco-nasdaq-100-etf.html",
            relation="same-family-other-variant",
            comparison="nasdaq-100-nr",
        ),
        _entry(
            "US9219438580",
            "VEA",
            "ftse-developed-ex-us-all-cap",
            "https://advisors.vanguard.com/investments/products/vea/vanguard-ftse-developed-markets-etf",
            relation="similar-exposure",
            comparison="msci-world-ex-usa-nr",
        ),
        _entry(
            "US46432F3964",
            "MTUM",
            "msci-usa-momentum-sr",
            "https://www.ishares.com/us/literature/sai/sai-ishares-trust-7-31.pdf",
            relation="similar-exposure",
            comparison="msci-usa-momentum",
        ),
        _entry(
            "US4642872349",
            "EEM",
            "msci-em-nr",
            "https://www.ishares.com/us/products/239637/ishares-msci-emerging-markets-etf-eem",
        ),
        _entry(
            "US92189F6768",
            "SMH",
            "marketvector-semiconductor-25",
            "https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/holdings",
            relation="similar-exposure",
            comparison="marketvector-semiconductor-screened",
        ),
        _entry(
            "US4642875235",
            "SOXX",
            "ice-nyse-semiconductor",
            "https://www.ishares.com/us/literature/fact-sheet/soxx-ishares-semiconductor-etf-fund-fact-sheet-en-us.pdf",
            relation="similar-exposure",
            comparison="msci-semiconductors-screened",
        ),
    )
}

# Only the exchange-qualified US registry may resolve a listing to this ISIN.
US_FUND_ISINS = {row.ticker: row.isin for row in FUND_BENCHMARKS.values() if row.domicile == "US"}


def fund_benchmark(isin: str | None) -> FundBenchmark | None:
    return FUND_BENCHMARKS.get((isin or "").strip().upper())
