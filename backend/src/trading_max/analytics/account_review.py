"""Deterministic historical account-review analytics for Invest and Stocks ISA.

The module is deliberately an in-memory calculation boundary.  It consumes
already-normalized Trading 212 transactions, the existing campaign ledger,
the existing NAV/money series, pre-calculated strategy metrics, and current
holdings.  It does not read artifacts, call providers, or publish reports.

Money and strategy metrics may be passed through from their authoritative
lenses.  The NAV fallback derives only cash money outcomes and phase evidence;
it never recalculates TWR or risk-adjusted ratios.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from statistics import median
from typing import Any, Literal

import pandas as pd

from .allocation import concentration
from .ledger import reconstruct_campaigns, summarize_campaigns

AccountKind = Literal["invest", "isa"]
CALCULATION_VERSION = "account-review-v1"
SCHEMA_VERSION = 1


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_safe(item) for item in value]
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        return _json_safe(value.item())
    return str(value)


def _finite(value: Any) -> float | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _first(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row:
            value = row[key]
            if value is not None and not (isinstance(value, str) and not value.strip()):
                return value
    return None


def _unavailable(reason: str, **values: Any) -> dict[str, Any]:
    return {"status": "unavailable", "unavailable_reason": reason, **values}


def _available(*, partial: bool = False, **values: Any) -> dict[str, Any]:
    return {
        "status": "partial" if partial else "available",
        "unavailable_reason": None,
        **values,
    }


def _records(
    value: pd.DataFrame | Sequence[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, pd.DataFrame):
        return [dict(row) for row in value.to_dict(orient="records")]
    return [dict(row) for row in value]


def _normalized_nav_rows(
    value: pd.DataFrame | Sequence[Mapping[str, Any]] | None,
) -> tuple[list[dict[str, Any]], str | None]:
    raw_rows = _records(value)
    if not raw_rows:
        return [], "NAV/money history was not supplied"
    rows: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_rows):
        date_value = _first(raw, "Date", "date", "as_of", "asOf")
        nav_value = _finite(
            _first(
                raw,
                "SyntheticNAVGBP",
                "ValueGBP",
                "value_gbp",
                "valueGbp",
                "value",
            )
        )
        if date_value is None or nav_value is None:
            return [], f"NAV/money row {index} is missing a valid date or value"
        observed = pd.to_datetime(date_value, utc=True, errors="coerce")
        if pd.isna(observed):
            return [], f"NAV/money row {index} has an invalid date"
        if nav_value < 0:
            return [], f"NAV/money row {index} has a negative account value"
        rows.append(
            {
                "date": observed,
                "value_gbp": nav_value,
                "external_flow_gbp": _finite(
                    _first(
                        raw,
                        "ExternalFlowGBP",
                        "external_flow_gbp",
                        "externalFlowGbp",
                        "external_flow",
                    )
                )
                or 0.0,
                "cash_gbp": _finite(_first(raw, "CashGBP", "cash_gbp", "cashGbp")),
                "market_value_gbp": _finite(
                    _first(raw, "MarketValueGBP", "market_value_gbp", "marketValueGbp")
                ),
                "source": _first(raw, "ValuationSource", "valuation_source", "source"),
            }
        )
    rows.sort(key=lambda row: row["date"])
    dates = [row["date"] for row in rows]
    if len(set(dates)) != len(dates):
        return [], "NAV/money history contains duplicate dates"
    return rows, None


def _money_from_nav(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    first = rows[0]
    last = rows[-1]
    initial_flow = float(first["external_flow_gbp"])
    opening_value = float(first["value_gbp"]) - initial_flow
    flows = [float(row["external_flow_gbp"]) for row in rows]
    deposits = sum(max(flow, 0.0) for flow in flows)
    signed_withdrawals = sum(min(flow, 0.0) for flow in flows)
    withdrawals = -signed_withdrawals
    net_flow = sum(flows)
    ending_value = float(last["value_gbp"])
    net_pnl = ending_value - opening_value - net_flow
    capital_base = opening_value + deposits

    cumulative_flow = 0.0
    peak = 0.0
    drawdowns: list[float] = []
    for row in rows:
        cumulative_flow += float(row["external_flow_gbp"])
        pnl = float(row["value_gbp"]) - opening_value - cumulative_flow
        peak = max(peak, pnl)
        drawdowns.append(pnl - peak)

    return _available(
        source="derived_from_nav_money_series",
        opening_value_gbp=opening_value,
        ending_value_gbp=ending_value,
        deposits_gbp=deposits,
        withdrawals_gbp=withdrawals,
        signed_withdrawal_flows_gbp=signed_withdrawals,
        net_external_flows_gbp=net_flow,
        net_pnl_gbp=net_pnl,
        net_pnl_rate=(net_pnl / capital_base if capital_base > 0 else None),
        capital_base_gbp=capital_base if capital_base > 0 else None,
        max_pnl_drawdown_gbp=min(drawdowns),
        current_pnl_drawdown_gbp=drawdowns[-1],
        observations=len(rows),
        metric_unavailable_reasons=(
            {}
            if capital_base > 0
            else {
                "net_pnl_rate": ("net P&L rate requires positive opening capital or gross deposits")
            }
        ),
    )


def _money_section(
    rows: Sequence[Mapping[str, Any]],
    money_outcome: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if money_outcome is not None:
        values = _json_safe(dict(money_outcome))
        values.pop("status", None)
        values.pop("unavailable_reason", None)
        values.setdefault("source", "authoritative_money_lens")
        return _available(**values)
    if not rows:
        return _unavailable(
            "money outcome requires the authoritative money lens or valid NAV/money history"
        )
    return _money_from_nav(rows)


def _strategy_section(strategy_risk: Mapping[str, Any] | None) -> dict[str, Any]:
    if strategy_risk is None:
        return _unavailable(
            "pre-calculated strategy and risk metrics were not supplied",
            source="precomputed_performance_required",
            metrics=None,
        )
    metrics = _json_safe(dict(strategy_risk))
    missing = {
        key: "the authoritative performance lens did not produce this metric"
        for key, value in metrics.items()
        if value is None
    }
    # Information ratio is benchmark-relative and therefore optional when no
    # aligned benchmark series was supplied. Its absence must not downgrade a
    # section whose cash-flow-neutral return and core risk metrics are intact.
    core_metric_names = {
        "twr_total_return",
        "annualized_return",
        "annualized_volatility",
        "sharpe_sonia",
        "sortino_sonia",
        "calmar_ratio",
        "max_drawdown",
        "current_drawdown",
    }
    missing_core = core_metric_names.intersection(missing)
    if missing:
        metrics["metric_unavailable_reasons"] = missing
    return _available(
        partial=bool(missing_core),
        source="precomputed_performance",
        metrics=metrics,
        metric_unavailable_reasons=missing,
    )


def _campaign_time(row: Mapping[str, Any], key: str) -> pd.Timestamp | None:
    value = row.get(key)
    observed = pd.to_datetime(value, utc=True, errors="coerce")
    return None if pd.isna(observed) else observed


def _holding_bucket(duration_days: float) -> str:
    if duration_days < 1:
        return "same_day"
    if duration_days <= 7:
        return "1_to_7_days"
    if duration_days <= 30:
        return "8_to_30_days"
    if duration_days <= 90:
        return "31_to_90_days"
    return "over_90_days"


def _campaign_detail(row: Mapping[str, Any], account_kind: AccountKind) -> dict[str, Any]:
    start = _campaign_time(row, "Start")
    end = _campaign_time(row, "End")
    duration = _finite(row.get("DurationDays"))
    if duration is None and start is not None and end is not None:
        duration = (end - start).total_seconds() / 86_400
    duration = max(duration or 0.0, 0.0)
    direction = str(row.get("Direction") or "long").strip().lower()
    if direction not in {"long", "short"}:
        direction = "long" if account_kind in {"invest", "isa"} else direction
    return {
        "ticker": str(row.get("Ticker") or "UNKNOWN").strip().upper(),
        "name": str(row.get("Name") or row.get("Ticker") or "Unknown").strip(),
        "start": start.isoformat() if start is not None else None,
        "end": end.isoformat() if end is not None else None,
        "duration_days": duration,
        "holding_bucket": _holding_bucket(duration),
        "direction": direction,
        "industry": (
            str(_first(row, "Industry", "industry", "Sector", "sector")).strip()
            if _first(row, "Industry", "industry", "Sector", "sector") is not None
            else None
        ),
        "country": (
            str(_first(row, "Country", "country")).strip()
            if _first(row, "Country", "country") is not None
            else None
        ),
        "buy_orders": int(_finite(row.get("BuyOrders")) or 0),
        "sell_orders": int(_finite(row.get("SellOrders")) or 0),
        "buy_notional_gbp": _finite(row.get("BuyNotional")) or 0.0,
        "sell_notional_gbp": _finite(row.get("SellNotional")) or 0.0,
        "gross_result_gbp": _finite(row.get("GrossResult")) or 0.0,
        "fees_gbp": _finite(row.get("Fees")) or 0.0,
        "net_result_gbp": _finite(row.get("NetResult")) or 0.0,
    }


def _maximum_streak(trades: Sequence[Mapping[str, Any]], *, winning: bool) -> int:
    longest = 0
    current = 0
    for trade in trades:
        result = float(trade["net_result_gbp"])
        matched = result > 0 if winning else result < 0
        if matched:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def _quantile(values: Sequence[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _trade_quality(
    campaigns: Sequence[Mapping[str, Any]],
    account_kind: AccountKind,
    transactions: pd.DataFrame | None,
    top_n: Sequence[int],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    trades = [_campaign_detail(row, account_kind) for row in campaigns]
    trades.sort(key=lambda row: (row["end"] or "", row["ticker"]))
    if not trades:
        return (
            _unavailable(
                "no reliably reconstructed closed campaigns are available",
                trade_count=0,
            ),
            [],
        )

    # Reuse the existing ledger summary for its established realised-P&L
    # semantics.  The additions below extend it with hold-time, streak, tail,
    # and counterfactual evidence without changing campaign reconstruction.
    summary_transactions = (
        transactions
        if transactions is not None and "TotalN" in transactions
        else pd.DataFrame({"TotalN": []})
    )
    established = summarize_campaigns(list(campaigns), summary_transactions)
    values = [float(trade["net_result_gbp"]) for trade in trades]
    durations = [float(trade["duration_days"]) for trade in trades]
    wins = [trade for trade in trades if float(trade["net_result_gbp"]) > 0]
    losses = [trade for trade in trades if float(trade["net_result_gbp"]) < 0]
    gross_wins = sum(float(trade["net_result_gbp"]) for trade in wins)
    gross_losses = -sum(float(trade["net_result_gbp"]) for trade in losses)
    total = sum(values)
    best = sorted(trades, key=lambda row: float(row["net_result_gbp"]), reverse=True)
    worst = list(reversed(best))
    counterfactuals: list[dict[str, Any]] = []
    for requested in sorted({number for number in top_n if number > 0}):
        count = min(requested, len(best))
        removed = best[:count]
        removed_result = sum(float(trade["net_result_gbp"]) for trade in removed)
        counterfactuals.append(
            {
                "remove_top_n": requested,
                "removed_trade_count": count,
                "removed_result_gbp": removed_result,
                "remaining_net_result_gbp": total - removed_result,
                "remaining_profitable": total - removed_result > 0,
            }
        )

    bucket_counts: dict[str, int] = {}
    for trade in trades:
        bucket = str(trade["holding_bucket"])
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1

    return (
        _available(
            scope="fully_closed_campaigns",
            trade_count=len(trades),
            win_count=len(wins),
            loss_count=len(losses),
            win_rate=established["win_rate"],
            average_win_gbp=established["avg_win"],
            average_loss_gbp=established["avg_loss"],
            payoff_ratio=established["payoff"],
            profit_factor=established["profit_factor"],
            expectancy_gbp=established["expectancy"],
            net_result_gbp=total,
            gross_wins_gbp=gross_wins,
            gross_losses_gbp=gross_losses,
            average_holding_days=sum(durations) / len(durations),
            median_holding_days=median(durations),
            same_day_count=bucket_counts.get("same_day", 0),
            short_holding_count=sum(duration <= 7 for duration in durations),
            long_holding_count=sum(duration > 90 for duration in durations),
            holding_bucket_counts=bucket_counts,
            longest_winning_streak=_maximum_streak(trades, winning=True),
            longest_losing_streak=_maximum_streak(trades, winning=False),
            left_tail_loss_p10_gbp=_quantile(
                [float(trade["net_result_gbp"]) for trade in losses], 0.1
            ),
            best_trade=(best[0] if best else None),
            worst_trade=(worst[0] if worst else None),
            best_trades=best[:5],
            worst_trades=worst[:5],
            best_trade_share_of_gross_wins=(
                float(best[0]["net_result_gbp"]) / gross_wins if gross_wins and best else None
            ),
            top_n_counterfactuals=counterfactuals,
            metric_unavailable_reasons={
                **(
                    {}
                    if wins
                    else {
                        "average_win_gbp": "no winning closed campaign is available",
                        "best_trade_share_of_gross_wins": (
                            "no winning closed campaign is available"
                        ),
                    }
                ),
                **(
                    {}
                    if losses
                    else {
                        "average_loss_gbp": "no losing closed campaign is available",
                        "left_tail_loss_p10_gbp": "no losing closed campaign is available",
                    }
                ),
                **(
                    {}
                    if wins and losses
                    else {
                        "payoff_ratio": "both winning and losing campaigns are required",
                    }
                ),
                **(
                    {}
                    if gross_losses
                    else {
                        "profit_factor": "profit factor requires a non-zero gross loss",
                    }
                ),
            },
        ),
        trades,
    )


def _aggregate(
    trades: Sequence[Mapping[str, Any]],
    key,
) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, float | int | str]] = {}
    for trade in trades:
        label = str(key(trade))
        bucket = buckets.setdefault(
            label,
            {
                "label": label,
                "trade_count": 0,
                "net_result_gbp": 0.0,
                "gross_wins_gbp": 0.0,
                "gross_losses_gbp": 0.0,
                "fees_gbp": 0.0,
            },
        )
        result = float(trade["net_result_gbp"])
        bucket["trade_count"] = int(bucket["trade_count"]) + 1
        bucket["net_result_gbp"] = float(bucket["net_result_gbp"]) + result
        bucket["gross_wins_gbp"] = float(bucket["gross_wins_gbp"]) + max(result, 0.0)
        bucket["gross_losses_gbp"] = float(bucket["gross_losses_gbp"]) + min(result, 0.0)
        bucket["fees_gbp"] = float(bucket["fees_gbp"]) + float(trade["fees_gbp"])
    absolute = sum(abs(float(bucket["net_result_gbp"])) for bucket in buckets.values())
    net = sum(float(bucket["net_result_gbp"]) for bucket in buckets.values())
    result = []
    for bucket in buckets.values():
        contribution = float(bucket["net_result_gbp"])
        result.append(
            {
                **bucket,
                "share_of_absolute_result": contribution / absolute if absolute else None,
                "share_of_net_result": contribution / net if abs(net) > 1e-12 else None,
            }
        )
    return sorted(result, key=lambda row: (-float(row["net_result_gbp"]), str(row["label"])))


def _attribution(trades: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not trades:
        reason = "realised attribution requires reliably reconstructed closed campaigns"
        return _unavailable(
            reason,
            scope="fully_closed_campaigns",
            by_instrument=_unavailable(reason, buckets=[]),
            by_industry=_unavailable(reason, buckets=[]),
            by_country=_unavailable(reason, buckets=[]),
            by_direction=_unavailable(reason, buckets=[]),
            by_holding_bucket=_unavailable(reason, buckets=[]),
            by_calendar=_unavailable(reason, year=[], month=[], weekday=[]),
            components=_unavailable(reason, buckets=[]),
        )

    def end_timestamp(trade: Mapping[str, Any]) -> pd.Timestamp:
        value = pd.to_datetime(trade.get("end"), utc=True, errors="coerce")
        return value if not pd.isna(value) else pd.Timestamp("1970-01-01", tz="UTC")

    dimensions = {
        "by_instrument": _aggregate(trades, lambda trade: trade["ticker"]),
        "by_direction": _aggregate(trades, lambda trade: trade["direction"]),
        "by_holding_bucket": _aggregate(trades, lambda trade: trade["holding_bucket"]),
    }
    classified_dimensions: dict[str, dict[str, Any]] = {}
    for dimension, field, label in (
        ("by_industry", "industry", "industry"),
        ("by_country", "country", "country"),
    ):
        classified = [trade for trade in trades if str(trade.get(field) or "").strip()]
        missing = len(trades) - len(classified)
        if not classified:
            classified_dimensions[dimension] = _unavailable(
                f"{label} metadata is unavailable for realised campaigns",
                buckets=[],
                missing_trade_count=missing,
            )
        else:
            classified_dimensions[dimension] = _available(
                partial=missing > 0,
                buckets=_aggregate(classified, lambda trade, key=field: trade[key]),
                missing_trade_count=missing,
            )
    calendar = {
        "year": _aggregate(trades, lambda trade: str(end_timestamp(trade).year)),
        "month": _aggregate(trades, lambda trade: end_timestamp(trade).strftime("%Y-%m")),
        "weekday": _aggregate(trades, lambda trade: end_timestamp(trade).strftime("%A")),
    }
    net = sum(float(trade["net_result_gbp"]) for trade in trades)
    gross = sum(float(trade["gross_result_gbp"]) for trade in trades)
    fees = sum(float(trade["fees_gbp"]) for trade in trades)
    dimension_totals = {
        dimension: sum(float(bucket["net_result_gbp"]) for bucket in buckets)
        for dimension, buckets in dimensions.items()
    }
    dimension_totals.update(
        {
            f"calendar_{dimension}": sum(float(bucket["net_result_gbp"]) for bucket in buckets)
            for dimension, buckets in calendar.items()
        }
    )
    return _available(
        scope="fully_closed_campaigns",
        realised_net_result_gbp=net,
        by_instrument=_available(buckets=dimensions["by_instrument"]),
        by_industry=classified_dimensions["by_industry"],
        by_country=classified_dimensions["by_country"],
        by_direction=_available(buckets=dimensions["by_direction"]),
        by_holding_bucket=_available(buckets=dimensions["by_holding_bucket"]),
        by_calendar=_available(**calendar),
        components=_available(
            buckets=[
                {"label": "gross_trade_result", "contribution_gbp": gross},
                {"label": "transaction_fees", "contribution_gbp": -fees},
                {"label": "net_realised_result", "contribution_gbp": net},
            ],
            conservation_difference_gbp=net - (gross - fees),
        ),
        conservation={dimension: total - net for dimension, total in dimension_totals.items()},
    )


def _nav_phase_observations(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    opening_value = float(rows[0]["value_gbp"]) - float(rows[0]["external_flow_gbp"])
    cumulative_flow = 0.0
    peak = 0.0
    previous_value = opening_value
    previous_drawdown = 0.0
    observations: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        value = float(row["value_gbp"])
        flow = float(row["external_flow_gbp"])
        cumulative_flow += flow
        pnl_level = value - opening_value - cumulative_flow
        peak = max(peak, pnl_level)
        drawdown = pnl_level - peak
        daily_pnl = value - previous_value - flow
        tolerance = max(0.01, abs(previous_value) * 0.001)
        flow_reference = max(abs(previous_value), abs(value - flow), 1.0)
        large_flow = abs(flow) >= flow_reference * 0.10 and abs(flow) > 0.01
        if large_flow:
            classification = "large_cash_flow"
        elif previous_drawdown < -tolerance and daily_pnl > tolerance:
            classification = "drawdown_recovery"
        elif daily_pnl < -tolerance and drawdown < previous_drawdown - 0.01:
            classification = "drawdown_formation"
        elif daily_pnl > tolerance:
            classification = "profit_phase"
        elif daily_pnl < -tolerance:
            classification = "loss_phase"
        else:
            classification = "flat_phase"
        observations.append(
            {
                "index": index,
                "date": row["date"],
                "value_gbp": value,
                "external_flow_gbp": flow,
                "daily_pnl_gbp": daily_pnl,
                "pnl_level_gbp": pnl_level,
                "pnl_drawdown_gbp": drawdown,
                "classification": classification,
            }
        )
        previous_value = value
        previous_drawdown = drawdown
    return observations


def _phase_evidence(observations: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    start = observations[0]
    end = observations[-1]
    largest_pnl = max(observations, key=lambda row: abs(float(row["daily_pnl_gbp"])))
    largest_flow = max(observations, key=lambda row: abs(float(row["external_flow_gbp"])))
    trough = min(observations, key=lambda row: float(row["pnl_drawdown_gbp"]))
    candidates = [
        {
            "type": "phase_start",
            "date": start["date"].date().isoformat(),
            "amount_gbp": float(start["daily_pnl_gbp"]),
            "detail": str(start["classification"]),
        },
        {
            "type": "largest_absolute_pnl_day",
            "date": largest_pnl["date"].date().isoformat(),
            "amount_gbp": float(largest_pnl["daily_pnl_gbp"]),
            "detail": "largest cash-flow-neutral daily money result in the phase",
        },
        {
            "type": "drawdown_trough",
            "date": trough["date"].date().isoformat(),
            "amount_gbp": float(trough["pnl_drawdown_gbp"]),
            "detail": "lowest cumulative money-P&L drawdown in the phase",
        },
    ]
    if abs(float(largest_flow["external_flow_gbp"])) > 0.01:
        candidates.append(
            {
                "type": "largest_external_flow",
                "date": largest_flow["date"].date().isoformat(),
                "amount_gbp": float(largest_flow["external_flow_gbp"]),
                "detail": "largest external cash flow in the phase",
            }
        )
    if end["date"] != start["date"]:
        candidates.append(
            {
                "type": "phase_end",
                "date": end["date"].date().isoformat(),
                "amount_gbp": float(end["daily_pnl_gbp"]),
                "detail": str(end["classification"]),
            }
        )
    seen: set[tuple[str, str]] = set()
    result: list[dict[str, Any]] = []
    for event in candidates:
        identity = (str(event["type"]), str(event["date"]))
        if identity not in seen:
            seen.add(identity)
            result.append(event)
    return result


def _phase_trade_attribution(
    trades: Sequence[Mapping[str, Any]], start: pd.Timestamp, end: pd.Timestamp
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected = []
    for trade in trades:
        observed = pd.to_datetime(trade.get("end"), utc=True, errors="coerce")
        if not pd.isna(observed) and start.normalize() <= observed.normalize() <= end.normalize():
            selected.append(trade)
    buckets = _aggregate(selected, lambda trade: trade["ticker"]) if selected else []
    contributors = [bucket for bucket in buckets if float(bucket["net_result_gbp"]) > 0][:3]
    detractors = sorted(
        (bucket for bucket in buckets if float(bucket["net_result_gbp"]) < 0),
        key=lambda row: float(row["net_result_gbp"]),
    )[:3]
    return contributors, detractors


def _phases(
    rows: Sequence[Mapping[str, Any]], trades: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    if len(rows) < 2:
        return _unavailable(
            "deterministic phase segmentation requires at least two NAV/money observations",
            items=[],
        )
    observations = _nav_phase_observations(rows)
    groups: list[list[dict[str, Any]]] = []
    for observation in observations:
        if not groups or groups[-1][-1]["classification"] != observation["classification"]:
            groups.append([observation])
        else:
            groups[-1].append(observation)

    phases: list[dict[str, Any]] = []
    for phase_index, group in enumerate(groups):
        first = group[0]
        last = group[-1]
        start_index = int(first["index"])
        opening_value = (
            float(rows[start_index - 1]["value_gbp"])
            if start_index > 0
            else float(rows[0]["value_gbp"]) - float(rows[0]["external_flow_gbp"])
        )
        ending_value = float(last["value_gbp"])
        external_flow = sum(float(row["external_flow_gbp"]) for row in group)
        contributors, detractors = _phase_trade_attribution(trades, first["date"], last["date"])
        phases.append(
            {
                "phase_id": f"phase-{phase_index + 1}",
                "classification": first["classification"],
                "start_date": first["date"].date().isoformat(),
                "end_date": last["date"].date().isoformat(),
                "opening_value_gbp": opening_value,
                "ending_value_gbp": ending_value,
                "net_external_flows_gbp": external_flow,
                "net_pnl_gbp": ending_value - opening_value - external_flow,
                "max_pnl_drawdown_gbp": min(float(row["pnl_drawdown_gbp"]) for row in group),
                "ending_pnl_drawdown_gbp": float(last["pnl_drawdown_gbp"]),
                "top_contributors": contributors,
                "top_detractors": detractors,
                "evidence_events": _phase_evidence(group),
            }
        )
    return _available(
        method="daily money-P&L state machine; contiguous equal states form phases",
        method_version=CALCULATION_VERSION,
        items=phases,
    )


def _active_position_counts(transactions: pd.DataFrame | None) -> list[int]:
    if transactions is None or transactions.empty:
        return []
    required = {"Action", "Shares"}
    if not required.issubset(transactions.columns):
        return []
    quantities: dict[str, float] = {}
    counts: list[int] = []
    ordered = transactions.sort_values("Time") if "Time" in transactions else transactions
    for _, row in ordered.iterrows():
        action = str(row.get("Action") or "").strip().lower()
        ticker = str(row.get("ISIN") or row.get("Ticker") or "").strip().upper()
        shares = _finite(row.get("Shares")) or 0.0
        if not ticker:
            continue
        if "buy" in action or action == "stock split open":
            quantities[ticker] = quantities.get(ticker, 0.0) + shares
        elif "sell" in action or action == "stock split close":
            quantities[ticker] = quantities.get(ticker, 0.0) - shares
        else:
            continue
        if abs(quantities[ticker]) <= 1e-7:
            quantities[ticker] = 0.0
        counts.append(sum(abs(quantity) > 1e-7 for quantity in quantities.values()))
    return counts


def _structural_diagnostics(
    transactions: pd.DataFrame | None,
    trades: Sequence[Mapping[str, Any]],
    nav_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    unavailable_reasons: list[str] = []
    if trades:
        winners = [trade for trade in trades if float(trade["net_result_gbp"]) > 0]
        losers = [trade for trade in trades if float(trade["net_result_gbp"]) < 0]
        gross_wins = sum(float(trade["net_result_gbp"]) for trade in winners)
        gross_losses = -sum(float(trade["net_result_gbp"]) for trade in losers)
        best = max(trades, key=lambda trade: float(trade["net_result_gbp"]))
        worst = min(trades, key=lambda trade: float(trade["net_result_gbp"]))
        observations.extend(
            [
                {
                    "diagnostic": "best_trade_dependence",
                    "value": (float(best["net_result_gbp"]) / gross_wins if gross_wins else None),
                    "evidence": {"ticker": best["ticker"], "result_gbp": best["net_result_gbp"]},
                },
                {
                    "diagnostic": "largest_loss_share",
                    "value": (
                        abs(float(worst["net_result_gbp"])) / gross_losses if gross_losses else None
                    ),
                    "evidence": {
                        "ticker": worst["ticker"],
                        "result_gbp": worst["net_result_gbp"],
                    },
                },
                {
                    "diagnostic": "short_holding_share",
                    "value": sum(float(trade["duration_days"]) <= 7 for trade in trades)
                    / len(trades),
                    "evidence": {"threshold_days": 7, "trade_count": len(trades)},
                },
            ]
        )
        if winners and losers:
            winner_median = median(float(trade["duration_days"]) for trade in winners)
            loser_median = median(float(trade["duration_days"]) for trade in losers)
            observations.append(
                {
                    "diagnostic": "winner_vs_loser_holding_days",
                    "value": loser_median - winner_median,
                    "evidence": {
                        "winner_median_days": winner_median,
                        "loser_median_days": loser_median,
                    },
                }
            )
    else:
        unavailable_reasons.append("closed campaigns are unavailable for trade-behaviour evidence")

    counts = _active_position_counts(transactions)
    gross_traded = None
    buy_orders = None
    sell_orders = None
    if (
        transactions is not None
        and not transactions.empty
        and {"Action", "TotalN"}.issubset(transactions.columns)
    ):
        actions = transactions["Action"].astype(str).str.lower()
        traded = actions.str.contains("buy") | actions.str.contains("sell")
        gross_traded = float(transactions.loc[traded, "TotalN"].abs().sum())
        buy_orders = int(actions.str.contains("buy").sum())
        sell_orders = int(actions.str.contains("sell").sum())
    else:
        unavailable_reasons.append("normalized transactions are unavailable for turnover evidence")

    drawdown_buy_notional = None
    if (
        nav_rows
        and transactions is not None
        and not transactions.empty
        and {
            "Action",
            "Time",
            "TotalN",
        }.issubset(transactions.columns)
    ):
        phase_rows = _nav_phase_observations(nav_rows)
        drawdown_days = {
            row["date"].date() for row in phase_rows if float(row["pnl_drawdown_gbp"]) < -0.01
        }
        buying = transactions[transactions["Action"].astype(str).str.lower().str.contains("buy")]
        drawdown_buy_notional = sum(
            float(row["TotalN"])
            for _, row in buying.iterrows()
            if pd.Timestamp(row["Time"]).date() in drawdown_days
        )
        observations.append(
            {
                "diagnostic": "buy_notional_during_money_drawdown_gbp",
                "value": drawdown_buy_notional,
                "evidence": {"drawdown_day_count": len(drawdown_days)},
            }
        )
    else:
        unavailable_reasons.append(
            "NAV and transaction dates are both required for drawdown-positioning evidence"
        )

    if not observations and gross_traded is None:
        return _unavailable(
            "; ".join(dict.fromkeys(unavailable_reasons)),
            observable_only=True,
            psychology_inferred=False,
            observations=[],
        )
    return _available(
        partial=bool(unavailable_reasons),
        observable_only=True,
        psychology_inferred=False,
        gross_traded_notional_gbp=gross_traded,
        buy_orders=buy_orders,
        sell_orders=sell_orders,
        average_active_positions_at_trade_events=(sum(counts) / len(counts) if counts else None),
        peak_active_positions_at_trade_events=max(counts) if counts else None,
        drawdown_buy_notional_gbp=drawdown_buy_notional,
        observations=observations,
        partial_reasons=list(dict.fromkeys(unavailable_reasons)),
    )


def _exposure_dimension(
    holdings: Sequence[Mapping[str, Any]],
    *,
    keys: Sequence[str],
    total_value: float,
    default: str | None = None,
) -> dict[str, Any]:
    buckets: dict[str, float] = {}
    missing = 0
    for holding in holdings:
        label = _first(holding, *keys) or default
        value = _finite(
            _first(
                holding,
                "current_value_gbp",
                "currentValueGbp",
                "MarketValueGBP",
                "market_value_gbp",
            )
        )
        if label is None or value is None:
            missing += 1
            continue
        text = str(label).strip() or "Unknown"
        buckets[text] = buckets.get(text, 0.0) + value
    if not buckets:
        return _unavailable(
            "the ending holdings do not contain this exposure dimension", buckets=[]
        )
    result = [
        {
            "label": label,
            "value_gbp": value,
            "weight": value / total_value if total_value > 0 else None,
        }
        for label, value in buckets.items()
    ]
    result.sort(key=lambda row: (-float(row["value_gbp"]), str(row["label"])))
    return _available(partial=missing > 0, missing_holding_count=missing, buckets=result)


def _ending_risk(
    ending_holdings: Sequence[Mapping[str, Any]] | None,
    nav_rows: Sequence[Mapping[str, Any]],
    account_kind: AccountKind,
) -> dict[str, Any]:
    if ending_holdings is None:
        return _unavailable(
            "ending holdings were not supplied",
            holdings=[],
            concentration=_unavailable("ending holdings were not supplied"),
        )
    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, holding in enumerate(ending_holdings):
        value = _finite(
            _first(
                holding,
                "current_value_gbp",
                "currentValueGbp",
                "MarketValueGBP",
                "market_value_gbp",
            )
        )
        if value is None:
            warnings.append(f"ending holding {index} has no finite GBP market value")
            continue
        if value < 0:
            warnings.append(f"ending holding {index} has a negative GBP market value")
            continue
        ticker = str(_first(holding, "ticker", "Ticker") or f"UNKNOWN-{index + 1}").strip()
        normalized.append(
            {
                "ticker": ticker,
                "name": str(_first(holding, "name", "Name") or ticker).strip(),
                "quantity": _finite(_first(holding, "quantity", "Quantity")),
                "current_value_gbp": value,
                "total_cost_gbp": _finite(
                    _first(holding, "total_cost_gbp", "totalCostGbp", "TotalCostGBP")
                ),
                "unrealized_pnl_gbp": _finite(
                    _first(
                        holding,
                        "unrealized_profit_loss_gbp",
                        "unrealizedProfitLossGbp",
                        "unrealized_pnl_gbp",
                    )
                ),
            }
        )
    total = sum(float(holding["current_value_gbp"]) for holding in normalized)
    for holding in normalized:
        holding["weight"] = float(holding["current_value_gbp"]) / total if total > 0 else None
    normalized.sort(key=lambda row: (-float(row["current_value_gbp"]), str(row["ticker"])))
    if total > 0:
        weights = {
            f"{holding['ticker']}#{index}": float(holding["current_value_gbp"])
            for index, holding in enumerate(normalized)
        }
        metrics = concentration(weights)
        concentration_section = _available(
            hhi=metrics.hhi,
            effective_positions=metrics.effective_positions,
            largest_weight=metrics.largest_weight,
            top_three_weight=sum(float(holding["weight"] or 0.0) for holding in normalized[:3]),
        )
    else:
        concentration_section = _unavailable("ending holdings contain no positive market value")

    source_holdings = list(ending_holdings)
    latest_nav = nav_rows[-1] if nav_rows else None
    account_value = float(latest_nav["value_gbp"]) if latest_nav else None
    cash = _finite(latest_nav.get("cash_gbp")) if latest_nav else None
    return _available(
        partial=bool(warnings),
        position_count=len(normalized),
        invested_value_gbp=total,
        account_value_gbp=account_value,
        cash_gbp=cash,
        cash_weight=(cash / account_value if cash is not None and account_value else None),
        unrealized_pnl_gbp=(
            sum(
                float(holding["unrealized_pnl_gbp"])
                for holding in normalized
                if holding["unrealized_pnl_gbp"] is not None
            )
            if any(holding["unrealized_pnl_gbp"] is not None for holding in normalized)
            else None
        ),
        holdings=normalized,
        concentration=concentration_section,
        exposures={
            "industry": _exposure_dimension(
                source_holdings,
                keys=("industry", "sector", "Industry", "Sector"),
                total_value=total,
            ),
            "country": _exposure_dimension(
                source_holdings,
                keys=("country", "Country"),
                total_value=total,
            ),
            "currency": _exposure_dimension(
                source_holdings,
                keys=("price_currency", "currency", "priceCurrency", "Currency"),
                total_value=total,
            ),
            "direction": _exposure_dimension(
                source_holdings,
                keys=("direction", "Direction"),
                total_value=total,
                default="long" if account_kind in {"invest", "isa"} else None,
            ),
        },
        warnings=warnings,
    )


def _transaction_coverage(transactions: pd.DataFrame | None) -> tuple[str | None, str | None]:
    if transactions is None or transactions.empty or "Time" not in transactions:
        return None, None
    times = pd.to_datetime(transactions["Time"], utc=True, errors="coerce").dropna()
    if times.empty:
        return None, None
    return times.min().date().isoformat(), times.max().date().isoformat()


def _coverage(
    *,
    transactions: pd.DataFrame | None,
    campaigns: Sequence[Mapping[str, Any]],
    nav_rows: Sequence[Mapping[str, Any]],
    nav_error: str | None,
    ending_holdings: Sequence[Mapping[str, Any]] | None,
    provenance: Mapping[str, Any] | None,
    currency: str,
    warnings: Sequence[str],
) -> dict[str, Any]:
    tx_start, tx_end = _transaction_coverage(transactions)
    nav_start = nav_rows[0]["date"].date().isoformat() if nav_rows else None
    nav_end = nav_rows[-1]["date"].date().isoformat() if nav_rows else None
    starts = [value for value in (tx_start, nav_start) if value is not None]
    ends = [value for value in (tx_end, nav_end) if value is not None]
    inputs = {
        "transactions": (
            _available(observations=len(transactions))
            if transactions is not None
            else _unavailable("normalized transactions were not supplied", observations=0)
        ),
        "campaigns": (
            _available(observations=len(campaigns))
            if campaigns
            else _unavailable("no closed campaigns were reconstructed", observations=0)
        ),
        "nav_money_series": (
            _available(observations=len(nav_rows))
            if nav_rows
            else _unavailable(nav_error or "NAV/money history was not supplied", observations=0)
        ),
        "ending_holdings": (
            _available(observations=len(ending_holdings))
            if ending_holdings is not None
            else _unavailable("ending holdings were not supplied", observations=0)
        ),
    }
    partial = any(section["status"] == "unavailable" for section in inputs.values()) or bool(
        warnings
    )
    return _available(
        partial=partial,
        currency=currency,
        start_date=min(starts) if starts else None,
        end_date=max(ends) if ends else None,
        transaction_count=len(transactions) if transactions is not None else 0,
        closed_campaign_count=len(campaigns),
        nav_observation_count=len(nav_rows),
        ending_holding_count=len(ending_holdings) if ending_holdings is not None else 0,
        inputs=inputs,
        quality={
            "status": "partial" if partial else "verified",
            "warnings": list(warnings),
        },
        provenance=_json_safe(dict(provenance or {})),
    )


def build_account_review(
    *,
    account_code: str,
    account_kind: AccountKind,
    transactions: pd.DataFrame | None,
    nav_money_series: pd.DataFrame | Sequence[Mapping[str, Any]] | None,
    ending_holdings: Sequence[Mapping[str, Any]] | None,
    campaigns: Sequence[Mapping[str, Any]] | None = None,
    money_outcome: Mapping[str, Any] | None = None,
    strategy_risk: Mapping[str, Any] | None = None,
    provenance: Mapping[str, Any] | None = None,
    currency: str = "GBP",
    top_n_counterfactuals: Sequence[int] = (1, 3, 5),
) -> dict[str, Any]:
    """Build a serializable seven-layer Invest/ISA historical review.

    ``money_outcome`` and ``strategy_risk`` are pass-through boundaries for
    existing authoritative analytics.  If ``money_outcome`` is omitted, only
    the cash money lens is derived from NAV and external-flow columns.  TWR,
    Sharpe, Sortino, Calmar, and IR are never recalculated here.
    """

    code = account_code.strip().upper()
    if not code:
        raise ValueError("account_code cannot be empty")
    if account_kind not in {"invest", "isa"}:
        raise ValueError("account_kind must be 'invest' or 'isa'")
    normalized_currency = currency.strip().upper()
    if len(normalized_currency) != 3:
        raise ValueError("currency must be a three-letter code")

    warnings: list[str] = []
    nav_rows, nav_error = _normalized_nav_rows(nav_money_series)
    if nav_error:
        warnings.append(nav_error)

    closed: list[dict[str, Any]] = []
    if campaigns is not None:
        closed = [dict(row) for row in campaigns]
    elif transactions is None:
        warnings.append("closed campaigns cannot be reconstructed without transactions")
    else:
        required = {"Action", "Time", "Shares", "TotalN", "FeeN", "ResultN"}
        missing = sorted(required - set(transactions.columns))
        if missing:
            warnings.append(
                "normalized transactions are missing campaign columns: " + ", ".join(missing)
            )
        else:
            try:
                reconstructed, _ = reconstruct_campaigns(transactions)
                closed = [dict(row) for row in reconstructed]
            except (KeyError, TypeError, ValueError) as exc:
                warnings.append(f"closed campaign reconstruction failed: {exc}")

    trade_quality, trades = _trade_quality(
        closed,
        account_kind,
        transactions,
        top_n_counterfactuals,
    )
    result = {
        "schema_version": SCHEMA_VERSION,
        "calculation_version": CALCULATION_VERSION,
        "account": {"code": code, "kind": account_kind, "currency": normalized_currency},
        "coverage": _coverage(
            transactions=transactions,
            campaigns=closed,
            nav_rows=nav_rows,
            nav_error=nav_error,
            ending_holdings=ending_holdings,
            provenance=provenance,
            currency=normalized_currency,
            warnings=warnings,
        ),
        "money_outcome": _money_section(nav_rows, money_outcome),
        "strategy_risk": _strategy_section(strategy_risk),
        "phases": _phases(nav_rows, trades),
        "realised_trade_quality": trade_quality,
        "attribution": _attribution(trades),
        "structural_diagnostics": _structural_diagnostics(
            transactions,
            trades,
            nav_rows,
        ),
        "ending_risk": _ending_risk(ending_holdings, nav_rows, account_kind),
        "warnings": warnings,
    }
    return _json_safe(result)


__all__ = [
    "CALCULATION_VERSION",
    "SCHEMA_VERSION",
    "build_account_review",
]
