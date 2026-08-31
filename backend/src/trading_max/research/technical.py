"""Typed technical, options, and ADR research.

This module is intentionally an artifact producer: it fetches provider data,
calculates indicators, and returns versioned models. It does not write dated
reports, render Markdown, or decide whether a position should be traded.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from pydantic import Field

from trading_max.domain import DomainModel


class MarketDataError(RuntimeError):
    """Raised when a provider cannot supply sufficient market history."""


class TechnicalResearchArtifact(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    artifact_type: str = "technical_research"
    ticker: str
    yf_ticker: str
    currency: str
    as_of: str
    generated_at: datetime
    history_coverage: dict[str, Any]
    adr_research: dict[str, Any] | None = None
    price: float | None
    returns: dict[str, float | None]
    moving_averages: dict[str, float | None]
    momentum: dict[str, Any]
    trend_strength: dict[str, float | None]
    volume: dict[str, float | None]
    structure: dict[str, Any]
    relative_strength: dict[str, Any]
    seasonality: list[dict[str, float | int]]
    seasonality_coverage: dict[str, Any]
    price_series: list[dict[str, Any]] = Field(default_factory=list)
    technical_score: int = Field(ge=0, le=100)
    technical_state: str
    signals: list[str]


class OptionsResearchArtifact(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    artifact_type: str = "options_research"
    ticker: str
    yf_ticker: str
    spot: float
    captured_at: datetime
    expiry_count: int = Field(ge=0)
    expiry_range: list[str]
    aggregate: dict[str, Any]
    gamma_proxy: dict[str, Any]
    expiries: list[dict[str, Any]]
    contracts: list[dict[str, Any]] = Field(default_factory=list)


OPTION_CONTRACT_MULTIPLIER = 100
RISK_FREE_RATE = 0.04
PRICE_SCALE = {"EQGB.L": 0.01, "IUMF.L": 0.01}
TECHNICAL_CURRENCY = {"SKHY": "USD"}
ADR_CONFIG: dict[str, dict[str, Any]] = {
    "TSM": {
        "primary_ticker": "2330.TW",
        "primary_currency": "TWD",
        "fx_ticker": "TWD=X",
        "ordinary_shares_per_adr": 5.0,
        "depositary": "Citibank",
        "ratio_source": (
            "https://www.sec.gov/Archives/edgar/data/1046179/000119312521118512/d94821dex2a1.htm"
        ),
    },
    "SKHY": {
        "primary_ticker": "000660.KS",
        "primary_currency": "KRW",
        "fx_ticker": "KRW=X",
        "ordinary_shares_per_adr": 0.1,
        "depositary": "Citibank",
        "ratio_source": (
            "https://depositaryreceipts.citi.com/adr/guides/"
            "pgm_dispabook.aspx?cusip=78392B206&pageId=15&subpageID=111"
        ),
    },
}


def _finite(value: float | int | np.number | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    number = float(value)
    return round(number, digits) if math.isfinite(number) else None


def _last(series: pd.Series) -> float | None:
    clean = series.dropna()
    return _finite(clean.iloc[-1]) if len(clean) else None


def _at(series: pd.Series, offset: int) -> float | None:
    clean = series.dropna()
    if len(clean) < abs(offset):
        return None
    return _finite(clean.iloc[offset])


def _return_over(series: pd.Series, sessions: int) -> float | None:
    clean = series.dropna()
    if len(clean) <= sessions:
        return None
    return _finite(clean.iloc[-1] / clean.iloc[-sessions - 1] - 1, 6)


def _pct_distance(price: float | None, reference: float | None) -> float | None:
    if price is None or reference is None or reference == 0:
        return None
    return _finite(price / reference - 1, 6)


def _monthly_seasonality(close: pd.Series) -> list[dict[str, float | int]]:
    monthly = close.resample("ME").last().dropna()
    if len(monthly) < 24:
        return []
    returns = monthly.pct_change().dropna()
    result: list[dict[str, float | int]] = []
    for month, values in returns.groupby(returns.index.month):
        clean = values.dropna()
        if len(clean) < 2:
            continue
        result.append(
            {
                "month": int(month),
                "meanReturn": float(clean.mean()),
                "medianReturn": float(clean.median()),
                "hitRate": float((clean > 0).mean()),
                "observations": len(clean),
                "best": float(clean.max()),
                "worst": float(clean.min()),
            }
        )
    return result


def _seasonality_coverage(close: pd.Series) -> dict[str, Any]:
    clean = close.dropna()
    monthly = clean.resample("ME").last().dropna()
    return {
        "basis": "full-listing-history",
        "first_session": str(clean.index[0].date()) if len(clean) else None,
        "last_session": str(clean.index[-1].date()) if len(clean) else None,
        "daily_sessions": len(clean),
        "monthly_observations": max(len(monthly) - 1, 0),
    }


def price_series(
    frame: pd.DataFrame,
    sma: dict[str, pd.Series],
    *,
    sessions: int = 504,
) -> list[dict[str, Any]]:
    """Export the recent OHLC window so the workbench can draw real candles.

    Only genuine sessions are emitted: rows are taken straight from the adjusted
    OHLCV frame, so a short listing history yields a short series instead of a
    padded or synthesised one.
    """
    if frame.empty:
        return []
    window = frame.tail(sessions)
    sma20 = sma.get("sma20")
    sma50 = sma.get("sma50")
    sma200 = sma.get("sma200")
    points: list[dict[str, Any]] = []
    for timestamp, row in window.iterrows():
        close = _finite(row.get("Close"))
        if close is None:
            continue
        points.append(
            {
                "date": str(timestamp.date()),
                "open": _finite(row.get("Open")),
                "high": _finite(row.get("High")),
                "low": _finite(row.get("Low")),
                "close": close,
                "volume": _finite(row.get("Volume"), 0),
                "sma20": _finite(sma20.get(timestamp)) if sma20 is not None else None,
                "sma50": _finite(sma50.get(timestamp)) if sma50 is not None else None,
                "sma200": _finite(sma200.get(timestamp)) if sma200 is not None else None,
            }
        )
    return points


def history(ticker: str, period: str = "3y", *, minimum_rows: int = 65) -> pd.DataFrame:
    """Fetch adjusted daily OHLCV and reject incomplete history loudly."""

    security = yf.Ticker(ticker)
    frame = security.history(period=period, auto_adjust=True)
    if frame.empty:
        raise MarketDataError(f"no OHLCV history returned for {ticker}")
    required = ["Open", "High", "Low", "Close", "Volume"]
    missing = [column for column in required if column not in frame]
    if missing:
        raise MarketDataError(f"{ticker}: OHLCV response missing {missing}")
    frame = frame[required].copy()
    frame = frame[~frame.index.duplicated(keep="last")]
    if frame["Close"].isna().iloc[-1]:
        price = security.fast_info.get("lastPrice")
        if price:
            for column in ("Open", "High", "Low", "Close"):
                if pd.isna(frame.loc[frame.index[-1], column]):
                    frame.loc[frame.index[-1], column] = float(price)
            if pd.isna(frame.loc[frame.index[-1], "Volume"]):
                frame.loc[frame.index[-1], "Volume"] = 0.0
    scale = PRICE_SCALE.get(ticker, 1.0)
    if scale != 1.0:
        frame[["Open", "High", "Low", "Close"]] *= scale
    frame = frame.dropna(subset=["Close"])
    if len(frame) < minimum_rows:
        raise MarketDataError(
            f"insufficient history for {ticker}: {len(frame)} rows (need >={minimum_rows})"
        )
    return frame


def history_coverage(ticker: str, frame: pd.DataFrame, requested_period: str) -> dict[str, Any]:
    expected_sessions = {"3y": 700, "2y": 460, "1y": 230, "6mo": 115, "3mo": 55}.get(
        requested_period
    )
    available = len(frame)
    complete = expected_sessions is None or available >= expected_sessions
    warning = None
    if not complete:
        warning = (
            f"{ticker}: requested {requested_period}, but only {available} genuine "
            "trading sessions are available; long-horizon indicators remain null."
        )
    return {
        "requested_period": requested_period,
        "available_sessions": available,
        "first_session": str(frame.index[0].date()),
        "last_session": str(frame.index[-1].date()),
        "complete": complete,
        "warning": warning,
    }


def adr_research(
    ticker: str,
    adr_frame: pd.DataFrame,
    period: str,
) -> dict[str, Any] | None:
    config = ADR_CONFIG.get(ticker)
    if config is None:
        return None
    primary = history(str(config["primary_ticker"]), period, minimum_rows=1)
    fx = history(str(config["fx_ticker"]), period, minimum_rows=1)
    adr_spot = float(adr_frame["Close"].dropna().iloc[-1])
    primary_spot = float(primary["Close"].dropna().iloc[-1])
    local_per_usd = float(fx["Close"].dropna().iloc[-1])
    ordinary_per_adr = float(config["ordinary_shares_per_adr"])
    parity_usd = primary_spot * ordinary_per_adr / local_per_usd
    return {
        "security_type": "ADR",
        "adr_ticker": ticker,
        "primary_ticker": config["primary_ticker"],
        "depositary": config["depositary"],
        "ordinary_shares_per_adr": ordinary_per_adr,
        "adr_per_ordinary_share": 1.0 / ordinary_per_adr,
        "adr_spot_usd": _finite(adr_spot, 4),
        "primary_spot": _finite(primary_spot, 4),
        "primary_currency": config["primary_currency"],
        "fx_local_per_usd": _finite(local_per_usd, 4),
        "parity_usd": _finite(parity_usd, 4),
        "premium_to_parity": _finite(adr_spot / parity_usd - 1.0, 6),
        "available_sessions": len(adr_frame),
        "first_trade_session": str(adr_frame.index[0].date()),
        "average_volume_20d": _finite(float(adr_frame["Volume"].tail(20).mean()), 0),
        "average_dollar_volume_20d": _finite(
            float((adr_frame["Close"] * adr_frame["Volume"]).tail(20).mean()), 0
        ),
        "arbitrage_assumption": "none",
        "warning": (
            "ADR premium is observed, not assumed to converge. Limited float and "
            "issuance/cancellation constraints can prevent clean arbitrage."
        ),
        "ratio_source": config["ratio_source"],
    }


def _rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = gains.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    avg_loss = losses.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    output = 100 - 100 / (1 + rs)
    output = output.mask((avg_gain == 0) & (avg_loss == 0), 50.0)
    output = output.mask((avg_gain > 0) & (avg_loss == 0), 100.0)
    return output.fillna(50.0)


def _adx_dmi(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    length: int = 14,
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0.0),
        index=close.index,
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0),
        index=close.index,
    )
    previous_close = close.shift(1)
    true_range = pd.concat(
        [high - low, (high - previous_close).abs(), (low - previous_close).abs()],
        axis=1,
    ).max(axis=1)
    atr = true_range.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / length, adjust=False, min_periods=length).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=1 / length, adjust=False, min_periods=length).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    return atr, plus_di, minus_di, adx


def _relative_stats(
    close: pd.Series, benchmark: pd.Series, sessions: int
) -> dict[str, float | None]:
    aligned = pd.concat(
        [close.rename("asset"), benchmark.rename("benchmark")], axis=1, sort=True
    ).dropna()
    if len(aligned) <= sessions:
        return {
            "asset_return": None,
            "benchmark_return": None,
            "excess_return": None,
            "beta": None,
            "correlation": None,
        }
    asset_return = aligned["asset"].iloc[-1] / aligned["asset"].iloc[-sessions - 1] - 1
    benchmark_return = aligned["benchmark"].iloc[-1] / aligned["benchmark"].iloc[-sessions - 1] - 1
    daily = aligned.pct_change().dropna().tail(sessions)
    variance = daily["benchmark"].var()
    beta = daily["asset"].cov(daily["benchmark"]) / variance if variance else np.nan
    return {
        "asset_return": _finite(asset_return, 6),
        "benchmark_return": _finite(benchmark_return, 6),
        "excess_return": _finite(asset_return - benchmark_return, 6),
        "beta": _finite(beta, 4),
        "correlation": _finite(daily["asset"].corr(daily["benchmark"]), 4),
    }


def technical_score(metrics: Mapping[str, Any]) -> tuple[int, str]:
    """Transparent state score; never a trade instruction."""

    score = 50
    price = metrics["price"]
    moving = metrics["moving_averages"]
    for key, weight in (("sma20", 4), ("sma50", 10), ("sma200", 12)):
        level = moving.get(key)
        if price is not None and level is not None:
            score += weight if price > level else -weight
    sma50, sma200 = moving.get("sma50"), moving.get("sma200")
    if sma50 is not None and sma200 is not None:
        score += 10 if sma50 > sma200 else -10
    slope = moving.get("sma50_slope_20d")
    if slope is not None:
        score += 6 if slope > 0 else -6
    macd = metrics["momentum"]["macd"]
    if macd["line"] is not None and macd["signal"] is not None:
        score += 5 if macd["line"] > macd["signal"] else -5
    if macd["histogram"] is not None:
        score += 4 if macd["histogram"] > 0 else -4
    rsi_now = metrics["momentum"]["rsi14"]
    if rsi_now is not None:
        if 50 <= rsi_now <= 70:
            score += 5
        elif rsi_now < 40:
            score -= 5
        elif rsi_now > 80:
            score -= 2
    for benchmark, weight in (("spy_63d", 6), ("soxx_63d", 3)):
        excess = metrics["relative_strength"][benchmark]["excess_return"]
        if excess is not None:
            score += weight if excess > 0 else -weight
    volume_ratio = metrics["volume"]["up_down_volume_ratio_20d"]
    if volume_ratio is not None:
        score += 3 if volume_ratio > 1 else -3
    trend = metrics["trend_strength"]
    if (
        trend["adx14"] is not None
        and trend["adx14"] >= 25
        and trend["plus_di14"] is not None
        and trend["minus_di14"] is not None
    ):
        score += 5 if trend["plus_di14"] > trend["minus_di14"] else -5
    score = max(0, min(100, score))
    state = (
        "强势趋势"
        if score >= 70
        else "偏强"
        if score >= 56
        else "中性/分歧"
        if score >= 45
        else "偏弱"
        if score >= 31
        else "弱势/趋势破坏"
    )
    return score, state


def signals(metrics: Mapping[str, Any]) -> list[str]:
    price = metrics["price"]
    moving = metrics["moving_averages"]
    momentum = metrics["momentum"]
    volume = metrics["volume"]
    structure = metrics["structure"]
    trend = metrics["trend_strength"]
    result: list[str] = []
    if price is not None and moving.get("sma200") is not None:
        result.append("价在200日线上" if price > moving["sma200"] else "价在200日线下")
    if moving.get("sma50") is not None and moving.get("sma200") is not None:
        result.append(
            "50日线高于200日线" if moving["sma50"] > moving["sma200"] else "50日线低于200日线"
        )
    cross = momentum["macd"]["cross"]
    if cross != "none":
        result.append(f"MACD {cross}")
    rsi_now = momentum["rsi14"]
    if rsi_now is not None and rsi_now <= 30:
        result.append("RSI超卖")
    elif rsi_now is not None and rsi_now >= 70:
        result.append("RSI超买")
    bollinger = structure["bollinger"]
    if bollinger["pct_b"] is not None and bollinger["pct_b"] >= 1:
        result.append("收盘突破布林上轨")
    elif bollinger["pct_b"] is not None and bollinger["pct_b"] <= 0:
        result.append("收盘跌破布林下轨")
    if bollinger["squeeze"]:
        result.append("布林带收缩（待突破）")
    if volume["up_down_volume_ratio_20d"] is not None:
        if volume["up_down_volume_ratio_20d"] < 0.80:
            result.append("下跌日量能占优")
        elif volume["up_down_volume_ratio_20d"] > 1.25:
            result.append("上涨日量能占优")
    if trend["adx14"] is not None and trend["adx14"] >= 25:
        direction = "上升趋势" if trend["plus_di14"] > trend["minus_di14"] else "下降趋势"
        result.append(f"ADX确认{direction}")
    if (
        structure["distance_to_support20"] is not None
        and abs(structure["distance_to_support20"]) <= 0.025
    ):
        result.append("接近20日支撑")
    if (
        structure["distance_to_resistance20"] is not None
        and abs(structure["distance_to_resistance20"]) <= 0.025
    ):
        result.append("接近20日阻力")
    return result


def analyze_ticker(
    label: str,
    yf_ticker: str,
    frame: pd.DataFrame,
    benchmarks: Mapping[str, pd.Series],
    *,
    currency: str = "USD",
    requested_period: str = "3y",
    adr: dict[str, Any] | None = None,
) -> TechnicalResearchArtifact:
    """Calculate all deterministic technical indicators for one security."""

    close = frame["Close"].astype(float)
    high = frame["High"].astype(float)
    low = frame["Low"].astype(float)
    volume = frame["Volume"].astype(float)
    price = _last(close)
    sma = {f"sma{n}": close.rolling(n, min_periods=n).mean() for n in (20, 50, 100, 200)}
    ema = {f"ema{n}": close.ewm(span=n, adjust=False, min_periods=n).mean() for n in (20, 50)}
    ema12 = close.ewm(span=12, adjust=False, min_periods=12).mean()
    ema26 = close.ewm(span=26, adjust=False, min_periods=26).mean()
    macd_line = ema12 - ema26
    macd_signal = macd_line.ewm(span=9, adjust=False, min_periods=9).mean()
    macd_hist = macd_line - macd_signal
    macd_cross = "none"
    if len(macd_line.dropna()) >= 2 and len(macd_signal.dropna()) >= 2:
        previous_line, current_line = _at(macd_line, -2), _at(macd_line, -1)
        previous_signal, current_signal = _at(macd_signal, -2), _at(macd_signal, -1)
        if None not in (previous_line, current_line, previous_signal, current_signal):
            if current_line > current_signal and previous_line <= previous_signal:
                macd_cross = "金叉"
            elif current_line < current_signal and previous_line >= previous_signal:
                macd_cross = "死叉"
    rsi14 = _rsi(close)
    rolling_high = high.rolling(14, min_periods=14).max()
    rolling_low = low.rolling(14, min_periods=14).min()
    stochastic_k = 100 * (close - rolling_low) / (rolling_high - rolling_low).replace(0, np.nan)
    stochastic_d = stochastic_k.rolling(3, min_periods=3).mean()
    bb_mid = close.rolling(20, min_periods=20).mean()
    bb_std = close.rolling(20, min_periods=20).std(ddof=0)
    bb_upper, bb_lower = bb_mid + 2 * bb_std, bb_mid - 2 * bb_std
    bb_width = (bb_upper - bb_lower) / bb_mid
    bb_pct_b = (close - bb_lower) / (bb_upper - bb_lower).replace(0, np.nan)
    bandwidth_now = _last(bb_width)
    bandwidth_history = bb_width.dropna().tail(126)
    squeeze = bool(
        len(bandwidth_history) >= 20
        and bandwidth_now is not None
        and bandwidth_now <= bandwidth_history.quantile(0.20)
    )
    atr14, plus_di14, minus_di14, adx14 = _adx_dmi(high, low, close)
    atr_now = _last(atr14)
    direction = np.sign(close.diff()).fillna(0)
    obv = (direction * volume).cumsum()
    volume20, volume60 = volume.tail(20).mean(), volume.tail(60).mean()
    up_volume = volume[close.diff() > 0].tail(20).sum()
    down_volume = volume[close.diff() < 0].tail(20).sum()
    obv_change = obv.iloc[-1] - obv.iloc[-21] if len(obv) > 20 else np.nan
    prior20_high, prior20_low = high.iloc[-21:-1], low.iloc[-21:-1]
    prior63_high, prior63_low = high.iloc[-64:-1], low.iloc[-64:-1]
    high52, low52 = high.tail(252).max(), low.tail(252).min()
    metrics: dict[str, Any] = {
        "ticker": label,
        "yf_ticker": yf_ticker,
        "currency": currency,
        "as_of": str(close.index[-1].date()),
        "history_coverage": history_coverage(label, frame, requested_period),
        "adr_research": adr,
        "price": price,
        "returns": {f"r_{n}d": _return_over(close, n) for n in (5, 20, 63, 126, 252)},
        "moving_averages": {
            **{name: _last(series) for name, series in sma.items()},
            **{name: _last(series) for name, series in ema.items()},
            "distance_sma20": _pct_distance(price, _last(sma["sma20"])),
            "distance_sma50": _pct_distance(price, _last(sma["sma50"])),
            "distance_sma100": _pct_distance(price, _last(sma["sma100"])),
            "distance_sma200": _pct_distance(price, _last(sma["sma200"])),
            "sma50_slope_20d": _pct_distance(_last(sma["sma50"]), _at(sma["sma50"], -21)),
            "sma200_slope_20d": _pct_distance(_last(sma["sma200"]), _at(sma["sma200"], -21)),
        },
        "momentum": {
            "macd": {
                "line": _last(macd_line),
                "signal": _last(macd_signal),
                "histogram": _last(macd_hist),
                "cross": macd_cross,
            },
            "rsi14": _last(rsi14),
            "stochastic_k14": _last(stochastic_k),
            "stochastic_d3": _last(stochastic_d),
        },
        "trend_strength": {
            "atr14": atr_now,
            "atr14_pct": _finite(atr_now / price if atr_now and price else np.nan, 6),
            "plus_di14": _last(plus_di14),
            "minus_di14": _last(minus_di14),
            "adx14": _last(adx14),
        },
        "volume": {
            "volume": _finite(volume.iloc[-1], 0),
            "average_volume_20d": _finite(volume20, 0),
            "average_volume_60d": _finite(volume60, 0),
            "volume_vs_20d": _finite(volume.iloc[-1] / volume20 if volume20 else np.nan, 4),
            "volume_vs_60d": _finite(volume.iloc[-1] / volume60 if volume60 else np.nan, 4),
            "up_down_volume_ratio_20d": _finite(
                up_volume / down_volume if down_volume else np.nan, 4
            ),
            "obv": _finite(obv.iloc[-1], 0),
            "obv_change_20d_in_avg_volumes": _finite(
                obv_change / volume20 if volume20 else np.nan, 4
            ),
        },
        "structure": {
            "bollinger": {
                "middle": _last(bb_mid),
                "upper": _last(bb_upper),
                "lower": _last(bb_lower),
                "pct_b": _last(bb_pct_b),
                "bandwidth": bandwidth_now,
                "squeeze": squeeze,
            },
            "support20": _finite(prior20_low.min()),
            "resistance20": _finite(prior20_high.max()),
            "support63": _finite(prior63_low.min()),
            "resistance63": _finite(prior63_high.max()),
            "distance_to_support20": _pct_distance(price, _finite(prior20_low.min())),
            "distance_to_resistance20": _pct_distance(_finite(prior20_high.max()), price),
            "high52": _finite(high52),
            "low52": _finite(low52),
            "drawdown_from_52w_high": _pct_distance(price, _finite(high52)),
            "above_52w_low": _pct_distance(price, _finite(low52)),
        },
        "relative_strength": {
            "spy_20d": _relative_stats(close, benchmarks["SPY"], 20),
            "spy_63d": _relative_stats(close, benchmarks["SPY"], 63),
            "spy_126d": _relative_stats(close, benchmarks["SPY"], 126),
            "qqq_63d": _relative_stats(close, benchmarks["QQQ"], 63),
            "soxx_63d": _relative_stats(close, benchmarks["SOXX"], 63),
        },
        "seasonality": _monthly_seasonality(close),
        "seasonality_coverage": _seasonality_coverage(close),
        "price_series": price_series(frame, sma),
    }
    score, state = technical_score(metrics)
    metrics["technical_score"] = score
    metrics["technical_state"] = state
    metrics["signals"] = signals(metrics)
    return TechnicalResearchArtifact(
        **metrics,
        generated_at=datetime.now(UTC),
    )


def _normal_pdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def _option_gex(options: pd.DataFrame, spot: float) -> pd.Series:
    if options.empty or spot <= 0:
        return pd.Series(dtype=float)
    sigma = options["iv"].to_numpy(dtype=float)
    strike = options["strike"].to_numpy(dtype=float)
    years = options["years"].to_numpy(dtype=float)
    oi = options["open_interest"].to_numpy(dtype=float)
    valid = (sigma > 0) & (strike > 0) & (years > 0) & (oi > 0)
    values = np.zeros(len(options), dtype=float)
    if valid.any():
        s, k, v, t, open_interest = spot, strike[valid], sigma[valid], years[valid], oi[valid]
        d1 = (np.log(s / k) + (RISK_FREE_RATE + 0.5 * v * v) * t) / (v * np.sqrt(t))
        gamma = _normal_pdf(d1) / (s * v * np.sqrt(t))
        gex = gamma * open_interest * OPTION_CONTRACT_MULTIPLIER * s * s * 0.01
        side = options.loc[valid, "side"].to_numpy()
        values[valid] = np.where(side == "call", gex, -gex)
    return pd.Series(values, index=options.index, dtype=float)


def _option_wall(options: pd.DataFrame, field: str) -> dict[str, float | None]:
    if options.empty or field not in options:
        return {"strike": None, field: None}
    grouped = options.groupby("strike", dropna=True)[field].sum().dropna()
    if grouped.empty or grouped.max() <= 0:
        return {"strike": None, field: None}
    strike = float(grouped.idxmax())
    return {"strike": _finite(strike, 2), field: _finite(grouped.loc[strike], 0)}


def _gamma_wall(options: pd.DataFrame, spot: float, side: str) -> dict[str, float | None]:
    selected = options[options["side"].eq(side)].copy()
    if selected.empty:
        return {"strike": None, "gex_1pct_absolute": None}
    selected["gex_1pct_absolute"] = _option_gex(selected, spot).abs()
    grouped = selected.groupby("strike")["gex_1pct_absolute"].sum().dropna()
    if grouped.empty or grouped.max() <= 0:
        return {"strike": None, "gex_1pct_absolute": None}
    strike = float(grouped.idxmax())
    return {
        "strike": _finite(strike, 2),
        "gex_1pct_absolute": _finite(grouped.loc[strike], 0),
    }


def _oi_weighted_iv(options: pd.DataFrame) -> float | None:
    if options.empty:
        return None
    total_oi = float(options["open_interest"].sum())
    if total_oi <= 0:
        return None
    return _finite(float((options["iv"] * options["open_interest"]).sum() / total_oi), 6)


def _max_pain(options: pd.DataFrame) -> float | None:
    if options.empty:
        return None
    strikes = np.sort(options["strike"].dropna().unique())
    if not len(strikes):
        return None
    calls = options[options["side"].eq("call")].groupby("strike")["open_interest"].sum()
    puts = options[options["side"].eq("put")].groupby("strike")["open_interest"].sum()
    losses = []
    for settle in strikes:
        call_loss = sum(float(oi) * max(settle - strike, 0.0) for strike, oi in calls.items())
        put_loss = sum(float(oi) * max(strike - settle, 0.0) for strike, oi in puts.items())
        losses.append(call_loss + put_loss)
    return _finite(float(strikes[int(np.argmin(losses))]), 2)


def _gamma_profile(
    options: pd.DataFrame, spot: float
) -> tuple[list[dict[str, float | None]], float | None]:
    if options.empty or spot <= 0:
        return [], None
    grid = np.linspace(spot * 0.75, spot * 1.25, 101)
    values = [float(_option_gex(options, float(hypothetical)).sum()) for hypothetical in grid]
    flip = None
    for left_spot, right_spot, left_gex, right_gex in zip(
        grid[:-1], grid[1:], values[:-1], values[1:], strict=True
    ):
        if left_gex == 0:
            flip = float(left_spot)
            break
        if left_gex * right_gex < 0:
            flip = float(
                left_spot
                + (right_spot - left_spot) * abs(left_gex) / (abs(left_gex) + abs(right_gex))
            )
            break
    return (
        [
            {"spot": _finite(s, 2), "net_gex_1pct": _finite(g, 0)}
            for s, g in zip(grid, values, strict=True)
        ],
        _finite(flip, 2),
    )


def _expiry_summary(options: pd.DataFrame, expiry: str, spot: float) -> dict[str, Any]:
    calls, puts = options[options["side"].eq("call")], options[options["side"].eq("put")]
    signed_gex = _option_gex(options, spot)
    call_gex = float(signed_gex.loc[calls.index].sum()) if len(calls) else 0.0
    put_gex = float(-signed_gex.loc[puts.index].sum()) if len(puts) else 0.0
    call_oi, put_oi = float(calls["open_interest"].sum()), float(puts["open_interest"].sum())
    call_volume, put_volume = float(calls["volume"].sum()), float(puts["volume"].sum())
    dte = (
        max((date.fromisoformat(expiry) - date.today()).days, 0) if expiry != "aggregate" else None
    )
    call_iv, put_iv = _oi_weighted_iv(calls), _oi_weighted_iv(puts)
    return {
        "expiry": expiry,
        "days_to_expiry": dte,
        "call_open_interest": _finite(call_oi, 0),
        "put_open_interest": _finite(put_oi, 0),
        "put_call_oi_ratio": _finite(put_oi / call_oi if call_oi else np.nan, 4),
        "call_volume": _finite(call_volume, 0),
        "put_volume": _finite(put_volume, 0),
        "put_call_volume_ratio": _finite(put_volume / call_volume if call_volume else np.nan, 4),
        "call_oi_weighted_iv": call_iv,
        "put_oi_weighted_iv": put_iv,
        "put_minus_call_iv": _finite((put_iv or np.nan) - (call_iv or np.nan), 6),
        "call_oi_wall": _option_wall(calls, "open_interest"),
        "put_oi_wall": _option_wall(puts, "open_interest"),
        "call_volume_wall": _option_wall(calls, "volume"),
        "put_volume_wall": _option_wall(puts, "volume"),
        "call_gamma_wall": _gamma_wall(options, spot, "call"),
        "put_gamma_wall": _gamma_wall(options, spot, "put"),
        "max_pain_proxy": _max_pain(options),
        "call_gex_1pct": _finite(call_gex, 0),
        "put_gex_1pct_absolute": _finite(put_gex, 0),
        "net_gex_1pct_proxy": _finite(float(signed_gex.sum()), 0),
    }


def _clean_contracts(frame: pd.DataFrame, side: str, expiry: date) -> pd.DataFrame:
    if frame.empty:
        return pd.DataFrame(
            columns=[
                "contract_symbol",
                "strike",
                "last_price",
                "bid",
                "ask",
                "open_interest",
                "volume",
                "iv",
                "in_the_money",
                "years",
                "side",
            ]
        )
    selected = frame.copy()
    for column in (
        "strike",
        "lastPrice",
        "bid",
        "ask",
        "openInterest",
        "volume",
        "impliedVolatility",
    ):
        selected[column] = pd.to_numeric(selected.get(column), errors="coerce")
    selected = selected.rename(
        columns={
            "contractSymbol": "contract_symbol",
            "lastPrice": "last_price",
            "openInterest": "open_interest",
            "impliedVolatility": "iv",
            "inTheMoney": "in_the_money",
        }
    )
    if "contract_symbol" not in selected:
        selected["contract_symbol"] = None
    if "in_the_money" not in selected:
        selected["in_the_money"] = False
    selected["in_the_money"] = selected["in_the_money"].fillna(False).astype(bool)
    selected["open_interest"] = selected["open_interest"].fillna(0.0)
    selected["volume"] = selected["volume"].fillna(0.0)
    selected["iv"] = selected["iv"].fillna(0.0)
    selected = selected[(selected["strike"] > 0) & (selected["open_interest"] >= 0)]
    selected["years"] = max((expiry - date.today()).days, 1) / 365.0
    selected["side"] = side
    return selected[
        [
            "contract_symbol",
            "strike",
            "last_price",
            "bid",
            "ask",
            "open_interest",
            "volume",
            "iv",
            "in_the_money",
            "years",
            "side",
        ]
    ].reset_index(drop=True)


def _contract_rows(options: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in options.to_dict(orient="records"):
        rows.append(
            {
                "expiry": str(row.get("expiry") or ""),
                "side": str(row.get("side") or ""),
                "contract_symbol": (
                    str(row["contract_symbol"]) if row.get("contract_symbol") else None
                ),
                "strike": _finite(row.get("strike"), 2),
                "last_price": _finite(row.get("last_price"), 4),
                "bid": _finite(row.get("bid"), 4),
                "ask": _finite(row.get("ask"), 4),
                "open_interest": _finite(row.get("open_interest"), 0),
                "volume": _finite(row.get("volume"), 0),
                "iv": _finite(row.get("iv"), 6),
                "in_the_money": bool(row.get("in_the_money", False)),
            }
        )
    return rows


def analyze_options(
    label: str,
    yf_ticker: str,
    spot: float,
    *,
    max_expiries: int = 8,
    max_days: int = 120,
) -> OptionsResearchArtifact:
    """Analyze public option OI/walls/GEX without implying dealer inventory."""

    security = yf.Ticker(yf_ticker)
    expiries: list[tuple[date, str]] = []
    for raw in security.options or ():
        try:
            expiry = date.fromisoformat(raw)
        except ValueError:
            continue
        if 0 <= (expiry - date.today()).days <= max_days:
            expiries.append((expiry, raw))
    expiries = sorted(expiries)[:max_expiries]
    if not expiries:
        raise MarketDataError(f"no option expiries within {max_days} days for {label}")
    expiry_rows: list[dict[str, Any]] = []
    contracts: list[pd.DataFrame] = []
    for expiry_date, raw_expiry in expiries:
        chain = security.option_chain(raw_expiry)
        calls = _clean_contracts(chain.calls, "call", expiry_date)
        puts = _clean_contracts(chain.puts, "put", expiry_date)
        options = pd.concat([calls, puts], ignore_index=True)
        if options.empty:
            continue
        expiry_rows.append(_expiry_summary(options, raw_expiry, spot))
        options["expiry"] = raw_expiry
        contracts.append(options)
    if not contracts:
        raise MarketDataError(f"no valid option contracts returned for {label}")
    all_options = pd.concat(contracts, ignore_index=True)
    aggregate = _expiry_summary(all_options, "aggregate", spot)
    profile, flip = _gamma_profile(all_options, spot)
    return OptionsResearchArtifact(
        ticker=label,
        yf_ticker=yf_ticker,
        spot=_finite(spot, 2) or spot,
        captured_at=datetime.now(UTC),
        expiry_count=len(expiry_rows),
        expiry_range=[expiry_rows[0]["expiry"], expiry_rows[-1]["expiry"]],
        aggregate=aggregate,
        gamma_proxy={
            "convention": (
                "call GEX positive, put GEX negative; assumes dealers are net "
                "short options and is not a measurement of dealer inventory"
            ),
            "gamma_regime": (
                "positive gamma proxy"
                if (aggregate["net_gex_1pct_proxy"] or 0) >= 0
                else "negative gamma proxy"
            ),
            "gamma_flip_proxy": flip,
            "profile": profile,
        },
        expiries=expiry_rows,
        contracts=_contract_rows(all_options),
    )


__all__ = [
    "ADR_CONFIG",
    "MarketDataError",
    "OptionsResearchArtifact",
    "TechnicalResearchArtifact",
    "analyze_options",
    "analyze_ticker",
    "history",
    "history_coverage",
    "price_series",
    "technical_score",
]
