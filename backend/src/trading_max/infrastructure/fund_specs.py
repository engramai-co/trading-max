"""Issuer download identities; these do not classify instruments as funds."""

from dataclasses import dataclass

HSBC_PRODUCT_URL = (
    "https://www.assetmanagement.hsbc.co.uk/en/individual-investor/funds/ie000kcs7j59"
)


@dataclass(frozen=True, slots=True)
class FundSpec:
    ticker: str
    isin: str
    name: str
    issuer: str
    source_url: str
    product_id: str | None = None
    data_isin: str | None = None
    holdings_url: str = ""
    aliases: tuple[str, ...] = ()
    asset_class: str = "Equity"


# These entries configure issuer-specific download adapters. They are not a
# security universe and are never used to decide whether an instrument is a
# fund. Security type is resolved dynamically by the reference-data service.
BUILTIN_FUND_ADAPTERS: dict[str, FundSpec] = {
    "SMGB": FundSpec(
        ticker="SMGB",
        isin="IE00BMC38736",
        name="VanEck Semiconductor UCITS ETF",
        issuer="VanEck",
        source_url="https://www.vaneck.com/uk/en/investments/semiconductor-etf/overview/",
        product_id="UCTSMH",
    ),
    "VUAG": FundSpec(
        ticker="VUAG",
        isin="IE00BFMXXD54",
        name="Vanguard S&P 500 UCITS ETF",
        issuer="Vanguard",
        product_id="9694",
        source_url="https://www.vanguard.co.uk/uk-fund-directory/product/etf/equity/9694/sp-500-ucits-etf-usd-accumulating",
    ),
    "VWRP": FundSpec(
        ticker="VWRP",
        isin="IE00BK5BQT80",
        name="Vanguard FTSE All-World UCITS ETF",
        issuer="Vanguard",
        product_id="9679",
        source_url="https://www.vanguard.co.uk/uk-fund-directory/product/etf/equity/9679/ftse-all-world-ucits-etf-usd-accumulating",
    ),
    "EIMI": FundSpec(
        ticker="EIMI",
        isin="IE00BKM4GZ66",
        name="iShares Core MSCI EM IMI UCITS ETF",
        issuer="iShares",
        product_id="264659",
        source_url="https://www.ishares.com/uk/individual/en/products/264659",
    ),
    "IGLT": FundSpec(
        ticker="IGLT",
        isin="IE00B1FZSB30",
        name="iShares Core UK Gilts UCITS ETF",
        issuer="iShares",
        product_id="251806",
        source_url="https://www.ishares.com/uk/individual/en/products/251806",
    ),
    "XUSE": FundSpec(
        ticker="XUSE",
        isin="IE000R4ZNTN3",
        name="iShares MSCI World ex-USA UCITS ETF",
        issuer="iShares",
        product_id="340748",
        source_url="https://www.ishares.com/uk/individual/en/products/340748",
    ),
    "SEMI": FundSpec(
        ticker="SEMI",
        isin="IE000I8KRLL9",
        name="iShares MSCI Global Semiconductors UCITS ETF",
        issuer="iShares",
        product_id="319084",
        source_url="https://www.ishares.com/uk/individual/en/products/319084",
    ),
    "IUMF": FundSpec(
        ticker="IUMF",
        isin="IE00BD1F4N50",
        name="iShares Edge MSCI USA Momentum Factor UCITS ETF",
        issuer="iShares",
        product_id="285208",
        source_url="https://www.ishares.com/uk/individual/en/products/285208",
    ),
    "EQGB": FundSpec(
        ticker="EQGB",
        isin="IE00BYVTMW98",
        name="Invesco EQQQ Nasdaq-100 UCITS ETF GBP Hdg Acc",
        issuer="Invesco",
        data_isin="IE00BYVTMW98",
        source_url=(
            "https://dng-api.invesco.com/cache/v1/accounts/en_GB/"
            "shareclasses/IE00BYVTMW98?idType=isin"
        ),
    ),
    "HEMC": FundSpec(
        ticker="HEMC",
        isin="IE000KCS7J59",
        name="HSBC MSCI Emerging Markets UCITS ETF",
        issuer="HSBC Asset Management",
        source_url=HSBC_PRODUCT_URL,
    ),
}
