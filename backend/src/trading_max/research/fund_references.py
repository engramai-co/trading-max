"""Issuer-verified US ETF references, keyed by the UCITS share-class ISIN."""

from typing import Literal

from trading_max.domain import DomainModel

from .held_funds import FundListingIdentity

US_MARKETS = frozenset(
    {"US", "XNYS", "XNAS", "ARCX", "BATS", "BZX", "NYSE", "NASDAQ", "NMS", "NYQ", "PCX"}
)


class USFund(DomainModel):
    ticker: str
    name: str
    exchange: str
    benchmark: str
    source_url: str


class USFundPeer(DomainModel):
    fund: USFund
    relation: Literal["same-index", "similar"]
    local_benchmark: str
    local_source_url: str
    verified_on: str = "2026-11-13"
    difference_en: str
    difference_zh: str


_US_FUNDS = {
    fund.ticker: fund
    for fund in (
        USFund(
            ticker="QQQ",
            name="Invesco QQQ ETF",
            exchange="NASDAQ",
            benchmark="Nasdaq-100 Total Return (XNDX)",
            source_url="https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf",
        ),
        USFund(
            ticker="QQQM",
            name="Invesco NASDAQ 100 ETF",
            exchange="NASDAQ",
            benchmark="Nasdaq-100 Total Return (XNDX)",
            source_url="https://www.invesco.com/us-rest/contentdetail?contentId=5b4d8e58e0737710VgnVCM1000006e36b50aRCRD&dnsName=us",
        ),
        USFund(
            ticker="VEA",
            name="Vanguard FTSE Developed Markets ETF",
            exchange="NYSE Arca",
            benchmark="FTSE Developed All Cap ex US Index",
            source_url="https://advisors.vanguard.com/investments/products/vea/vanguard-ftse-developed-markets-etf",
        ),
        USFund(
            ticker="MTUM",
            name="iShares MSCI USA Momentum Factor ETF",
            exchange="Cboe BZX",
            benchmark="MSCI USA Momentum SR Variant Index",
            source_url="https://www.ishares.com/us/products/251614/ishares-msci-usa-momentum-factor-etf",
        ),
        USFund(
            ticker="EEM",
            name="iShares MSCI Emerging Markets ETF",
            exchange="NYSE Arca",
            benchmark="MSCI Emerging Markets Index (Net)",
            source_url="https://www.ishares.com/us/products/239637/ishares-msci-emerging-markets-etf-eem",
        ),
        USFund(
            ticker="SMH",
            name="VanEck Semiconductor ETF",
            exchange="NASDAQ",
            benchmark="MVIS US Listed Semiconductor 25 Index",
            source_url="https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/",
        ),
        USFund(
            ticker="SOXX",
            name="iShares Semiconductor ETF",
            exchange="NASDAQ",
            benchmark="NYSE Semiconductor Index",
            source_url="https://www.ishares.com/us/literature/fact-sheet/soxx-ishares-semiconductor-etf-fund-fact-sheet-en-us.pdf",
        ),
    )
}


def _peer(ticker, benchmark, source, en, zh, *, relation="similar") -> USFundPeer:
    return USFundPeer(
        fund=_US_FUNDS[ticker],
        relation=relation,
        local_benchmark=benchmark,
        local_source_url=source,
        difference_en=en,
        difference_zh=zh,
    )


_PEERS = {
    # The first reference provides the UCITS option chain.
    "IE00BYVTMW98": tuple(
        _peer(
            ticker,
            "Nasdaq-100 Notional Net Total Return (XNDXNNR)",
            "https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE00BYVTMW98_factsheet_en.pdf",
            "Same Nasdaq-100 constituents; gross vs. notional net return. EQGB is GBP hedged; the US fund trades in USD without that hedge.",
            "纳斯达克 100 成分相同；总回报和名义净总回报口径不同。EQGB 做 GBP 对冲，美国基金以 USD 报价且无该对冲。",
        )
        for ticker in ("QQQ", "QQQM")
    ),
    "IE000R4ZNTN3": (
        _peer(
            "VEA",
            "MSCI World Ex US Net Index",
            "https://www.ishares.com/uk/individual/en/products/340748/",
            "Both cover developed markets outside the US. FTSE also includes small caps and classifies South Korea as developed.",
            "均覆盖美国以外的发达市场。FTSE 也纳入小盘股，并将韩国归为发达市场。",
        ),
    ),
    "IE00BD1F4N50": (
        _peer(
            "MTUM",
            "MSCI USA Momentum Factor Net Index",
            "https://www.ishares.com/uk/individual/en/products/285208/ishares-edge-msci-usa-momentum-factor-ucits-etf",
            "Both target US momentum; MTUM uses the SR Variant.",
            "均跟踪美国动量因子；MTUM 采用 SR 变体。",
        ),
    ),
    "IE000KCS7J59": (
        _peer(
            "EEM",
            "MSCI Emerging Markets Net",
            "https://www.assetmanagement.hsbc.co.uk/en/intermediary/funds/ie000kcs7j59",
            "Same MSCI Emerging Markets net return benchmark. HEMC trades in GBP; EEM trades in USD.",
            "同为 MSCI 新兴市场净回报基准。HEMC 以 GBP 报价，EEM 以 USD 报价。",
            relation="same-index",
        ),
    ),
    "IE00BMC38736": (
        _peer(
            "SMH",
            "MarketVector US Listed Semiconductor 10% Capped Screened Index (MVSMCTR)",
            "https://www.vaneck.com/uk/en/investments/semiconductor-etf/overview/",
            "Both cover US-listed semiconductors. The UCITS index has a 10% cap and ESG screens.",
            "均覆盖美国上市的半导体公司；UCITS 指数设有 10% 权重上限和 ESG 筛选。",
        ),
    ),
    "IE000I8KRLL9": (
        _peer(
            "SOXX",
            "MSCI ACWI IMI Semiconductors & Semiconductor Equipment ESG Screened Select Capped Index",
            "https://www.ishares.com/uk/professionals/en/products/319084/",
            "Both cover semiconductors. SOXX uses a US-listed universe; SEMI uses a global, ESG-screened, capped index.",
            "均覆盖半导体。SOXX 限于美国上市公司，SEMI 采用全球指数并设有 ESG 筛选和权重上限。",
        ),
    ),
}


def us_fund(ticker: str) -> USFund | None:
    return _US_FUNDS.get(ticker.upper())


def fund_peers(isin: str | None) -> tuple[USFundPeer, ...]:
    return _PEERS.get((isin or "").upper(), ())


def us_fund_listing(listing: FundListingIdentity) -> bool:
    return listing.ticker == listing.symbol and (
        listing.mic in US_MARKETS
        or listing.exchange in US_MARKETS
        or (not listing.mic and listing.isin.startswith("US"))
    )
