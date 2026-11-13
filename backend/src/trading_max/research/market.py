"""Typed market and technical research orchestration.

The service returns structured artifacts and coverage warnings. It never
writes reports, mutates the repository, or launches a subprocess. Provider
adapters are injected so offline contract tests can exercise the complete
calculation boundary without network access.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

import pandas as pd
from pydantic import Field

from trading_max.domain import DomainModel
from trading_max.reference import is_fund_instrument

from .calendar import completed_daily_bars
from .technical import (
    MarketDataError,
    OptionsResearchArtifact,
    TechnicalResearchArtifact,
    adr_research,
    analyze_options,
    analyze_ticker,
    history,
    price_series,
)


class TechnicalResearchBatch(DomainModel):
    """One deterministic batch for a watchlist research run."""

    schema_version: int = Field(default=1, ge=1)
    artifact_type: str = "technical_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[TechnicalResearchArtifact]
    benchmark_series: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    benchmark_currency: str | None = None
    benchmark_return_basis: str | None = None
    benchmark_fx_ticker: str | None = None
    warnings: list[str] = Field(default_factory=list)


class OptionsResearchBatch(DomainModel):
    """Options artifacts aligned with the technical batch."""

    schema_version: int = Field(default=1, ge=1)
    artifact_type: str = "options_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[OptionsResearchArtifact]
    warnings: list[str] = Field(default_factory=list)


HistoryLoader = Callable[[str, str], pd.DataFrame]
OptionsLoader = Callable[[str, str, float], OptionsResearchArtifact]
AdrLoader = Callable[[str, pd.DataFrame, str], dict[str, Any] | None]


def _gbp_benchmark_series(
    asset_frame: pd.DataFrame,
    gbp_usd_frame: pd.DataFrame,
    *,
    sessions: int = 2_000,
) -> list[dict[str, Any]]:
    """Return an adjusted USD benchmark from a GBP investor's perspective.

    ``GBPUSD=X`` is quoted as USD per GBP, so an adjusted USD close is divided
    by the FX close. Each leg is forward-filled independently across the union
    of their genuine sessions. This preserves FX-only weekdays without
    inventing weekend observations or future prices.
    """

    if asset_frame.empty or gbp_usd_frame.empty:
        return []

    def daily_close(frame: pd.DataFrame, name: str) -> pd.Series:
        values = pd.to_numeric(frame["Close"], errors="coerce").to_numpy()
        index = pd.DatetimeIndex([timestamp.date() for timestamp in frame.index])
        return pd.Series(values, index=index, name=name).groupby(level=0).last()

    asset = daily_close(asset_frame, "asset_usd")
    fx = daily_close(gbp_usd_frame, "usd_per_gbp")
    aligned = pd.concat([asset, fx], axis=1, sort=True).sort_index().ffill().dropna()
    aligned = aligned[(aligned["asset_usd"] > 0) & (aligned["usd_per_gbp"] > 0)]
    if aligned.empty:
        return []
    gbp = pd.DataFrame({"Close": aligned["asset_usd"] / aligned["usd_per_gbp"]})
    return price_series(gbp, {}, sessions=sessions)


def _default_history(ticker: str, period: str) -> pd.DataFrame:
    return history(ticker, period)


def _default_options(
    ticker: str,
    yf_ticker: str,
    spot: float,
) -> OptionsResearchArtifact:
    return analyze_options(ticker, yf_ticker, spot, max_expiries=4)


class MarketResearchService:
    """Fetch and calculate typed technical/options artifacts for tickers."""

    def __init__(
        self,
        *,
        history_loader: HistoryLoader = _default_history,
        options_loader: OptionsLoader = _default_options,
        adr_loader: AdrLoader = adr_research,
    ) -> None:
        self.history_loader = history_loader
        self.options_loader = options_loader
        self.adr_loader = adr_loader

    def run(
        self,
        tickers: Sequence[str],
        *,
        requested_period: str = "3y",
        history_period: str = "max",
        include_options: bool = True,
        fund_tickers: Collection[str] = (),
    ) -> tuple[TechnicalResearchBatch, OptionsResearchBatch]:
        universe = list(dict.fromkeys(item.strip().upper() for item in tickers if item.strip()))
        if not universe:
            raise MarketDataError("technical research requires at least one ticker")

        # Relative-performance inputs can fail independently of listing prices.
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="research-benchmark") as pool:
            histories = {
                symbol: pool.submit(self.history_loader, symbol, history_period)
                for symbol in ("SPY", "QQQ", "SOXX", "GBPUSD=X", "VOO", "VT")
            }
        technical_rows: list[TechnicalResearchArtifact] = []
        option_rows: list[OptionsResearchArtifact] = []
        identified_funds = set(fund_tickers)
        warnings: list[str] = []
        option_warnings: list[str] = []
        benchmark_series: dict[str, list[dict[str, Any]]] = {}
        benchmark_closes = {}
        now = pd.Timestamp.now(tz="UTC")
        for symbol in ("SPY", "QQQ", "SOXX"):
            try:
                benchmark_closes[symbol] = completed_daily_bars(
                    histories[symbol].result(), now=now
                )["Close"]
            except Exception as exc:
                benchmark_closes[symbol] = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
                warnings.append(
                    f"{symbol}: relative benchmark unavailable ({type(exc).__name__}: {exc})"
                )
        try:
            gbp_usd_frame = histories["GBPUSD=X"].result()
        except Exception as exc:
            gbp_usd_frame = pd.DataFrame()
            warnings.append(
                f"GBPUSD=X: benchmark FX history unavailable ({type(exc).__name__}: {exc})"
            )
        for benchmark in ("VOO", "QQQ", "VT"):
            try:
                frame = histories[benchmark].result()
                benchmark_series[benchmark] = _gbp_benchmark_series(
                    frame,
                    gbp_usd_frame,
                    sessions=2_000,
                )
            except Exception as exc:
                warnings.append(
                    f"{benchmark}: benchmark history unavailable ({type(exc).__name__}: {exc})"
                )
        for ticker in universe:
            try:
                frame = (
                    histories[ticker].result()
                    if ticker in histories
                    else self.history_loader(ticker, history_period)
                )
                provider_type = str(frame.attrs.get("asset_type") or "").upper()
                expected_fund = ticker in fund_tickers
                if expected_fund and provider_type and provider_type not in {"ETF", "MUTUALFUND"}:
                    raise MarketDataError("provider did not return a fund listing")
                fund = (
                    expected_fund
                    or provider_type == "MUTUALFUND"
                    or is_fund_instrument(quote_type=provider_type)
                )
                if fund:
                    identified_funds.add(ticker)
                    if not provider_type:
                        frame = frame.copy()
                        frame.attrs["asset_type"] = "ETF"
                adr = None if fund else self.adr_loader(ticker, frame, requested_period)
                technical_rows.append(
                    analyze_ticker(
                        ticker,
                        ticker,
                        frame,
                        benchmark_closes,
                        requested_period=requested_period,
                        adr=adr,
                    )
                )
                # Option quotes use the latest genuine price, independent of completed-day studies.
                spot = float(frame["Close"].iloc[-1])
                if include_options and not fund:
                    try:
                        option_rows.append(self.options_loader(ticker, ticker, spot))
                    except Exception as exc:
                        option_warnings.append(
                            f"{ticker}: options unavailable ({type(exc).__name__}: {exc})"
                        )
            except Exception as exc:
                warnings.append(
                    f"{ticker}: technical research failed ({type(exc).__name__}: {exc})"
                )

        if not technical_rows and any(ticker not in identified_funds for ticker in universe):
            raise MarketDataError("; ".join(warnings) or "technical research returned no rows")
        as_of = max((row.as_of for row in technical_rows), default=now.date().isoformat())
        generated_at = datetime.now(UTC)
        technical_batch = TechnicalResearchBatch(
            as_of=as_of,
            generated_at=generated_at,
            tickers=universe,
            rows=technical_rows,
            benchmark_series=benchmark_series,
            benchmark_currency="GBP",
            benchmark_return_basis="auto_adjusted_close",
            benchmark_fx_ticker="GBPUSD=X",
            warnings=warnings + option_warnings,
        )
        options_batch = OptionsResearchBatch(
            as_of=as_of,
            generated_at=generated_at,
            tickers=[ticker for ticker in universe if ticker not in identified_funds],
            rows=option_rows,
            warnings=option_warnings,
        )
        return technical_batch, options_batch


__all__ = [
    "MarketResearchService",
    "OptionsResearchBatch",
    "TechnicalResearchBatch",
]
