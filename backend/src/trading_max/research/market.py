"""Typed market and technical research orchestration.

The service returns structured artifacts and coverage warnings. It never
writes reports, mutates the repository, or launches a subprocess. Provider
adapters are injected so offline contract tests can exercise the complete
calculation boundary without network access.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import pandas as pd
from pydantic import Field

from trading_max.domain import DomainModel

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
    ) -> tuple[TechnicalResearchBatch, OptionsResearchBatch]:
        universe = list(dict.fromkeys(item.strip().upper() for item in tickers if item.strip()))
        if not universe:
            raise MarketDataError("technical research requires at least one ticker")

        benchmark_frames = {
            benchmark: self.history_loader(benchmark, history_period)
            for benchmark in ("SPY", "QQQ", "SOXX")
        }
        benchmark_closes = {
            benchmark: frame["Close"] for benchmark, frame in benchmark_frames.items()
        }
        technical_rows: list[TechnicalResearchArtifact] = []
        option_rows: list[OptionsResearchArtifact] = []
        warnings: list[str] = []
        option_warnings: list[str] = []
        benchmark_series: dict[str, list[dict[str, Any]]] = {}
        for benchmark in ("VOO", "QQQ", "VT"):
            try:
                frame = benchmark_frames.get(benchmark)
                if frame is None:
                    frame = self.history_loader(benchmark, history_period)
                benchmark_series[benchmark] = price_series(frame, {}, sessions=2_000)
            except Exception as exc:
                warnings.append(
                    f"{benchmark}: benchmark history unavailable ({type(exc).__name__}: {exc})"
                )
        for ticker in universe:
            try:
                frame = self.history_loader(ticker, history_period)
                adr = self.adr_loader(ticker, frame, requested_period)
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
                spot = technical_rows[-1].price
                if include_options and spot is not None:
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

        if not technical_rows:
            raise MarketDataError("; ".join(warnings) or "technical research returned no rows")
        as_of = max(row.as_of for row in technical_rows)
        generated_at = datetime.now(UTC)
        technical_batch = TechnicalResearchBatch(
            as_of=as_of,
            generated_at=generated_at,
            tickers=universe,
            rows=technical_rows,
            benchmark_series=benchmark_series,
            warnings=warnings + option_warnings,
        )
        options_batch = OptionsResearchBatch(
            as_of=as_of,
            generated_at=generated_at,
            tickers=universe,
            rows=option_rows,
            warnings=option_warnings,
        )
        return technical_batch, options_batch


__all__ = [
    "MarketResearchService",
    "OptionsResearchBatch",
    "TechnicalResearchBatch",
]
