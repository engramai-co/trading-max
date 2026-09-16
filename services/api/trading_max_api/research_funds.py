"""Independent issuer-backed fund research; no dependency on broker ingestion."""

from __future__ import annotations

import re
import threading
from datetime import UTC, datetime
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from pydantic import Field
from trading_max.analytics.lookthrough import FundSnapshot
from trading_max.infrastructure.fund_holdings import (
    BUILTIN_FUND_ADAPTERS,
    USER_AGENT,
    OfficialFundHoldingsProvider,
)
from trading_max.research.facts import fingerprint, number

from .models import ApiModel
from .valuation_assumptions import _atomic_write


class FundReturnYear(ApiModel):
    year: int
    nav_return: float
    benchmark_return: float
    tracking_difference: float


class FundResearch(ApiModel):
    ticker: str
    fetched_at: str
    source_url: str | None = None
    issuer: str | None = None
    isin: str | None = None
    index_name: str | None = None
    share_currency: str | None = None
    base_currency: str | None = None
    income_use: str | None = None
    methodology: str | None = None
    replication: str | None = None
    domicile: str | None = None
    inception: str | None = None
    total_assets_label: str | None = None
    total_assets_as_of: str | None = None
    expense_ratio: float | None = None
    hedging: str | None = None
    holdings: FundSnapshot | None = None
    return_currency: str | None = None
    return_basis: str | None = None
    annual_returns: list[FundReturnYear] = Field(default_factory=list)
    tracking_error: float | None = None
    tracking_error_state: str = "daily-nav-and-index-history-unavailable"
    state: str = "available"
    warnings: list[str] = Field(default_factory=list)


def parse_ishares_page(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    facts, dates = {}, {}
    for label in soup.select('span.label[data-id^="keyFundFacts-"]'):
        row = label.find_parent("tr")
        value = row.select_one("td") if row else None
        key = str(label.get("data-id")).removeprefix("keyFundFacts-").removesuffix("-label")
        if value:
            facts[key] = value.get_text(" ", strip=True)
            as_of = row.select_one(".as-of-date")
            if as_of:
                dates[key] = as_of.get_text(" ", strip=True).removeprefix("as of ")
    mapping = {
        "isin": "isin",
        "index_name": "indexSeriesName",
        "share_currency": "seriesBaseCurrencyCode",
        "base_currency": "baseCurrencyCode",
        "income_use": "useOfProfitsCode",
        "replication": "productStructure",
        "methodology": "fundMethodologyTypeCode",
        "domicile": "domicile",
        "inception": "inceptionDate",
        "total_assets_label": "totalNetAssets",
    }
    result = {key: facts.get(field) for key, field in mapping.items()}
    expense = number(str(facts.get("emeaMgt") or "").replace("%", ""))
    result["expense_ratio"] = expense / 100 if expense is not None else None
    result["total_assets_as_of"] = dates.get("totalNetAssets")
    rows = []
    nav = soup.select_one('tr[webqc-datapoint="annualNav"]')
    benchmark = soup.select_one('tr[webqc-datapoint="benchmarkAnnual"]')
    if nav and benchmark and nav.find_parent("table") is benchmark.find_parent("table"):
        years = [cell.get_text(strip=True) for cell in nav.find_parent("table").select("thead th")]
        nav_header = nav.select_one("th").get_text(" ", strip=True)
        benchmark_header = benchmark.select_one("th").get_text(" ", strip=True)
        currency = re.search(r"\b([A-Z]{3})\b", nav_header)
        benchmark_currency = re.search(r"\b([A-Z]{3})\b", benchmark_header)
        nums = [number(cell.get_text(strip=True)) for cell in nav.select("td")]
        refs = [number(cell.get_text(strip=True)) for cell in benchmark.select("td")]
        if (
            currency
            and benchmark_currency
            and currency[1] == benchmark_currency[1]
            and len(years) == len(nums) == len(refs)
        ):
            for year, value, ref in zip(years, nums, refs, strict=True):
                if re.fullmatch(r"\d{4}", year) and value is not None and ref is not None:
                    rows.append(
                        {
                            "year": int(year),
                            "nav_return": value / 100,
                            "benchmark_return": ref / 100,
                            "tracking_difference": (value - ref) / 100,
                        }
                    )
            result["return_currency"] = currency[1]
            hint = benchmark.select_one("button[title]")
            if hint:
                result["index_name"] = str(hint.get("title", "")).removeprefix("Index: ")
            result["return_basis"] = (
                "NAV total return, income reinvested; issuer-published annual returns rounded to 0.1 percentage point"
            )
    result["annual_returns"] = rows
    return result


class FundResearchService:
    def __init__(self, root: Path):
        self.root = root / "research-cache" / "funds"
        self.provider = OfficialFundHoldingsProvider(root)
        self.lock = threading.RLock()

    def get(self, ticker: str, metrics: dict) -> FundResearch:
        with self.lock:
            path = self.root / (fingerprint([ticker, "fund-research-v2"]) + ".json")
            previous = None
            if path.exists():
                previous = FundResearch.model_validate_json(path.read_text())
                if (
                    datetime.now(UTC) - datetime.fromisoformat(previous.fetched_at)
                ).total_seconds() < 64800:
                    return previous
            spec = BUILTIN_FUND_ADAPTERS.get(ticker.removesuffix(".L"))
            result = FundResearch(
                ticker=ticker,
                fetched_at=datetime.now(UTC).isoformat(),
                source_url=spec.source_url if spec else None,
                issuer=spec.issuer if spec else metrics.get("fundFamily"),
                isin=spec.isin if spec else None,
                base_currency=metrics.get("fundCurrency"),
                expense_ratio=number(metrics.get("annualReportExpenseRatio")),
            )
            try:
                result.holdings = self.provider.fetch(ticker)
            except Exception as exc:
                result.warnings.append("holdings: " + type(exc).__name__)
                if previous:
                    result.holdings = previous.holdings
            if spec and spec.issuer == "iShares":
                try:
                    response = httpx.get(
                        spec.source_url,
                        headers={"User-Agent": USER_AGENT},
                        follow_redirects=True,
                        timeout=25,
                    )
                    response.raise_for_status()
                    parsed = parse_ishares_page(response.text)
                    if parsed.get("isin") != spec.isin:
                        raise ValueError("share-class-mismatch")
                    result = FundResearch.model_validate(
                        {**result.model_dump(by_alias=False), **parsed}
                    )
                except Exception as exc:
                    if previous:
                        result = previous.model_copy(
                            update={
                                "state": "stale",
                                "warnings": ["issuer-profile: " + type(exc).__name__],
                            }
                        )
                    else:
                        result.warnings.append("issuer-profile: " + type(exc).__name__)
            if result.holdings is None and not result.annual_returns and not result.expense_ratio:
                result.state = "missing"
            _atomic_write(path, result.model_dump(mode="json"))
            return result
