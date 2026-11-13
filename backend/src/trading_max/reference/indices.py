"""Canonical benchmark identities and explicitly typed market-data series.

Fund links consume an issuer's benchmark field; a fund's name or listing
ticker is never evidence of which benchmark it tracks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

IndexScope = Literal[
    "global", "us", "eu", "uk", "jp", "hk", "kr", "cn", "tw", "in", "ca", "au", "ch"
]
IndexRange = Literal["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"]
IndexBasis = Literal["price", "net-return", "total-return", "implied-volatility"]
IndexKind = Literal["index", "etf-price", "volatility"]
UsageRights = Literal["provider-terms", "licensed-source-required"]


@dataclass(frozen=True, slots=True)
class IndexSpec:
    id: str
    scope: IndexScope
    name: str
    name_zh: str
    compiler: str
    compiler_id: str
    symbol: str | None
    currency: str | None
    calendar: str
    basis: IndexBasis = "price"
    kind: IndexKind = "index"
    history_years: int = 5
    rights: UsageRights = "provider-terms"
    benchmark_id: str | None = None
    basket: str | None = None
    aliases: tuple[str, ...] = ()
    hourly_close: bool = False
    # A market-board proxy may supply dated weights, never index attribution.
    proxy_basket: str | None = None

    @property
    def ranges(self) -> tuple[IndexRange, ...]:
        if not self.symbol:
            return ()
        if self.history_years:
            return ("1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX")
        if self.hourly_close:
            return ("1D", "1W", "1M", "3M", "6M", "1Y")
        return ("1D", "1W", "1M")

    @property
    def benchmark(self) -> str:
        return self.benchmark_id or self.id


# history_years is the configured daily coverage, not a promise that the
# provider has every bar. Non-exchange composite calendars are descriptive.
INDEX_REGISTRY = {
    row.id: row
    for row in (
        IndexSpec(
            "sp-500",
            "us",
            "S&P 500",
            "标普 500",
            "S&P DJI",
            "SPX",
            "^GSPC",
            "USD",
            "XNYS",
            basket="us",
            aliases=("标普", "SPX", "S&P 500 Index (Net)", "S&P 500 Index (Net Total Return)"),
        ),
        IndexSpec(
            "nasdaq-100",
            "us",
            "Nasdaq 100",
            "纳斯达克 100",
            "Nasdaq",
            "NDX",
            "^NDX",
            "USD",
            "XNAS",
            basket="ndx",
            aliases=(
                "纳指",
                "NDX",
                "NASDAQ 100 Index (Net)",
                "NASDAQ-100 Index",
                "NASDAQ-100 Notional Index (Net Total Return)",
            ),
        ),
        IndexSpec(
            "dow-jones",
            "us",
            "Dow Jones Industrial Average",
            "道琼斯工业平均指数",
            "S&P DJI",
            "DJI",
            "^DJI",
            "USD",
            "XNYS",
            aliases=("道琼斯", "DJIA"),
        ),
        IndexSpec(
            "russell-2000",
            "us",
            "Russell 2000",
            "罗素 2000",
            "FTSE Russell",
            "RUT",
            "^RUT",
            "USD",
            "XNYS",
        ),
        IndexSpec(
            "vix",
            "us",
            "VIX",
            "VIX",
            "Cboe",
            "VIX",
            "^VIX",
            None,
            "XCBF",
            basis="implied-volatility",
            kind="volatility",
        ),
        IndexSpec(
            "ftse-100",
            "uk",
            "FTSE 100",
            "富时 100",
            "FTSE Russell",
            "UKX",
            "^FTSE",
            "GBP",
            "XLON",
            basket="uk",
            aliases=("FTSE 100 Index (Net)",),
        ),
        IndexSpec(
            "ftse-250", "uk", "FTSE 250", "富时 250", "FTSE Russell", "MCX", "^FTMC", "GBP", "XLON"
        ),
        IndexSpec(
            "msci-japan",
            "jp",
            "MSCI Japan",
            "MSCI 日本",
            "MSCI",
            "939200",
            None,
            "USD",
            "XTKS",
            basis="net-return",
            history_years=0,
            rights="licensed-source-required",
            basket="jp",
            aliases=("MSCI Japan Index (Net)",),
        ),
        IndexSpec(
            "nikkei-225",
            "jp",
            "Nikkei 225",
            "日经 225",
            "Nikkei",
            "N225",
            "^N225",
            "JPY",
            "XTKS",
            aliases=("日经", "日経平均", "Nikkei Stock Average"),
        ),
        IndexSpec(
            "topix",
            "jp",
            "TOPIX ETF price",
            "TOPIX ETF 价格",
            "JPX",
            "TOPIX",
            "1306.T",
            "JPY",
            "XTKS",
            kind="etf-price",
            aliases=("TOPIX", "Tokyo Stock Price Index"),
        ),
        IndexSpec(
            "hang-seng",
            "hk",
            "Hang Seng",
            "恒生指数",
            "Hang Seng Indexes",
            "HSI",
            "^HSI",
            "HKD",
            "XHKG",
            aliases=("恒指",),
            proxy_basket="hk",
        ),
        IndexSpec(
            "hang-seng-china-enterprises",
            "hk",
            "Hang Seng China Enterprises",
            "恒生中国企业指数",
            "Hang Seng Indexes",
            "HSCEI",
            "^HSCE",
            "HKD",
            "XHKG",
            aliases=("国企指数", "HSCEI"),
        ),
        IndexSpec(
            "hang-seng-tech",
            "hk",
            "Hang Seng TECH ETF price",
            "恒生科技 ETF 价格",
            "Hang Seng Indexes",
            "HSTECH",
            "3067.HK",
            "HKD",
            "XHKG",
            kind="etf-price",
            aliases=("恒生科技", "Hang Seng TECH Index"),
        ),
        IndexSpec(
            "kospi",
            "kr",
            "KOSPI",
            "韩国综合指数",
            "KRX",
            "KOSPI",
            "^KS11",
            "KRW",
            "XKRX",
            proxy_basket="kr",
        ),
        IndexSpec(
            "kosdaq", "kr", "KOSDAQ", "韩国创业板指数", "KRX", "KOSDAQ", "^KQ11", "KRW", "XKRX"
        ),
        IndexSpec(
            "euro-stoxx-50",
            "eu",
            "EURO STOXX 50",
            "欧洲斯托克 50",
            "STOXX",
            "SX5E",
            "^STOXX50E",
            "EUR",
            "STOXX-Europe",
        ),
        IndexSpec(
            "stoxx-europe-600",
            "eu",
            "STOXX Europe 600",
            "斯托克欧洲 600",
            "STOXX",
            "SXXP",
            "^STOXX",
            "EUR",
            "STOXX-Europe",
        ),
        IndexSpec(
            "dax",
            "eu",
            "DAX",
            "德国 DAX",
            "STOXX",
            "DAX",
            "^GDAXI",
            "EUR",
            "XETR",
            basis="total-return",
        ),
        IndexSpec(
            "cac-40", "eu", "CAC 40", "法国 CAC 40", "Euronext", "PX1", "^FCHI", "EUR", "XPAR"
        ),
        # Yahoo has intraday bars but no multi-session daily or weekly closes
        # for the CSI 300 or ChiNext. Their quote is not a history series.
        IndexSpec(
            "csi-300",
            "cn",
            "CSI 300",
            "沪深 300",
            "CSI",
            "000300",
            "000300.SS",
            "CNY",
            "XSHG",
            history_years=0,
        ),
        IndexSpec(
            "sse-composite",
            "cn",
            "SSE Composite Index",
            "上证指数",
            "SSE / CSI",
            "000001",
            "000001.SS",
            "CNY",
            "XSHG",
            aliases=("上证综指", "Shanghai Composite"),
        ),
        IndexSpec(
            "shenzhen-component",
            "cn",
            "Shenzhen Component Index",
            "深证成指",
            "SZSE / CNI",
            "399001",
            "399001.SZ",
            "CNY",
            "XSHG",
            aliases=("Shenzhen Index",),
        ),
        IndexSpec(
            "chinext",
            "cn",
            "ChiNext Index",
            "创业板指",
            "SZSE / CNI",
            "399006",
            "399006.SZ",
            "CNY",
            "XSHG",
            history_years=0,
        ),
        IndexSpec("taiex", "tw", "TAIEX", "台湾加权指数", "TWSE", "TAIEX", "^TWII", "TWD", "XTAI"),
        IndexSpec(
            "nifty-50",
            "in",
            "Nifty 50",
            "印度 Nifty 50",
            "NSE Indices",
            "NIFTY 50",
            "^NSEI",
            "INR",
            "XNSE",
        ),
        IndexSpec(
            "sensex", "in", "SENSEX", "印度 SENSEX", "BSE", "SENSEX", "^BSESN", "INR", "XBOM"
        ),
        IndexSpec(
            "sp-tsx",
            "ca",
            "S&P/TSX Composite",
            "标普多伦多综合指数",
            "S&P DJI",
            "SPTSX",
            "^GSPTSE",
            "CAD",
            "XTSE",
        ),
        IndexSpec(
            "asx-200",
            "au",
            "S&P/ASX 200",
            "标普澳洲 200",
            "S&P DJI",
            "AS51",
            "^AXJO",
            "AUD",
            "XASX",
        ),
        IndexSpec("smi", "ch", "SMI", "瑞士市场指数", "SIX", "SMI", "^SSMI", "CHF", "XSWX"),
        IndexSpec(
            "msci-world",
            "global",
            "MSCI World",
            "MSCI 世界",
            "MSCI",
            "990100",
            "^990100-USD-STRD",
            "USD",
            "MSCI-global",
            aliases=("MSCI World Index (Net)",),
        ),
        IndexSpec(
            "msci-acwi",
            "global",
            "MSCI ACWI",
            "MSCI 全球",
            "MSCI",
            "892400",
            "^892400-USD-STRD",
            "USD",
            "MSCI-global",
            aliases=("MSCI All Country World Index", "MSCI ACWI Index (Net)"),
        ),
        IndexSpec(
            "msci-world-ex-usa",
            "global",
            "MSCI World ex USA",
            "MSCI 世界（除美国）",
            "MSCI",
            "991000",
            "^991000-USD-STRD",
            "USD",
            "MSCI-global",
            history_years=0,
            hourly_close=True,
            aliases=("MSCI World ex USA Index (Net)",),
        ),
        IndexSpec(
            "msci-em",
            "global",
            "MSCI Emerging Markets",
            "MSCI 新兴市场",
            "MSCI",
            "891800",
            "^891800-USD-STRD",
            "USD",
            "MSCI-global",
            history_years=0,
            hourly_close=True,
            aliases=("MSCI EM",),
        ),
        IndexSpec(
            "msci-em-imi",
            "global",
            "MSCI Emerging Markets IMI",
            "MSCI 新兴市场 IMI",
            "MSCI",
            "664220",
            "^664220-USD-STRD",
            "USD",
            "MSCI-global",
            history_years=0,
            hourly_close=True,
            aliases=(
                "MSCI Emerging Markets Investable Market Index",
                "MSCI Emerging Markets Investable Market Index (USD) (Net)",
                "MSCI EM IMI Index (Net)",
            ),
        ),
        IndexSpec(
            "ftse-all-world",
            "global",
            "FTSE All-World",
            "富时全球指数",
            "FTSE Russell",
            "AW01",
            None,
            "USD",
            "FTSE-global",
            history_years=0,
            rights="licensed-source-required",
        ),
        IndexSpec(
            "ftse-all-world-etf",
            "global",
            "FTSE All-World ETF price",
            "富时全球 ETF 价格",
            "FTSE Russell",
            "AW01",
            "VWRP.L",
            "GBP",
            "XLON",
            kind="etf-price",
            benchmark_id="ftse-all-world",
        ),
    )
}


def _key(value: str) -> str:
    return "".join(char for char in value.casefold() if char.isalnum() or char == "^")


# Only exact benchmark labels supplied by issuers are allowed here. Search
# also matches translated names and ticker aliases, but does not identify funds.
_BENCHMARK_NAMES = {
    _key(name): spec.benchmark
    for spec in INDEX_REGISTRY.values()
    for label in (spec.name, *spec.aliases)
    for name in (label, label + " Index")
    if label.isascii()
}


def issuer_benchmark_id(index_name: str | None) -> str | None:
    """Link an issuer-supplied benchmark to a family, not its displayed return variant."""

    return _BENCHMARK_NAMES.get(_key(index_name or ""))
