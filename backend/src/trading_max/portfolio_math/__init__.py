"""Pure calculations kept in parity with Trading Max's Returns & Risk page."""

from .benchmark_comparison import benchmark_comparison
from .drawdown_episodes import deepest_drawdown, drawdown_episodes
from .history import (
    PORTFOLIO_RANGES,
    history_day,
    history_display_interval,
    history_window,
    portfolio_range,
    select_portfolio_history,
    trading_day,
)
from .math import drawdowns, minimum_observed
from .money import portfolio_money
from .nav import difference, in_range, nav_number, observed_nav, period_return
from .prepared import exact_instant, pnls_at, prepare_history
from .return_periods import return_periods
from .types import (
    BenchmarkComparison,
    BenchmarkPricePoint,
    HistoryInput,
    HistorySelection,
    IndexedDrawdownEpisode,
    Money,
    NavPoint,
    PortfolioHistory,
    PreparedHistory,
    Range,
    ReturnPeriods,
    Scope,
)

__all__ = [
    "PORTFOLIO_RANGES",
    "BenchmarkComparison",
    "BenchmarkPricePoint",
    "HistoryInput",
    "HistorySelection",
    "IndexedDrawdownEpisode",
    "Money",
    "NavPoint",
    "PortfolioHistory",
    "PreparedHistory",
    "Range",
    "ReturnPeriods",
    "Scope",
    "benchmark_comparison",
    "deepest_drawdown",
    "difference",
    "drawdown_episodes",
    "drawdowns",
    "exact_instant",
    "history_day",
    "history_display_interval",
    "history_window",
    "in_range",
    "minimum_observed",
    "nav_number",
    "observed_nav",
    "period_return",
    "pnls_at",
    "portfolio_money",
    "portfolio_range",
    "prepare_history",
    "return_periods",
    "select_portfolio_history",
    "trading_day",
]
