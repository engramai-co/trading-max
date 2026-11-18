"""Compare the same fiscal-period estimate across two successful publications."""

from datetime import date, datetime
from typing import Literal

from trading_max.domain import DomainModel
from trading_max.research.facts import number


class EstimateChange(DomainModel):
    metric: Literal["eps", "revenue"]
    end: date
    period: Literal["0q", "+1q", "0y", "+1y"]
    currency: str
    previous: float
    current: float
    change: float
    previous_as_of: str
    current_as_of: str


def consensus_estimates(analyst):
    estimates = []
    for field, metric in (("earningsEstimate", "eps"), ("revenueEstimate", "revenue")):
        for row in analyst.get(field) or []:
            if not isinstance(row, dict):
                continue
            period, end = row.get("period") or row.get("index"), row.get("endDate")
            mean, currency = number(row.get("avg")), row.get("currency")
            try:
                day = date.fromisoformat(end[:10]).isoformat()
            except (ValueError, TypeError):
                continue
            if currency and mean is not None and period in {"0q", "+1q", "0y", "+1y"}:
                estimates.append(
                    {
                        "metric": metric,
                        "end": day,
                        "period": period,
                        "currency": currency,
                        "mean": mean,
                    }
                )
    return sorted(estimates, key=lambda r: (r["end"], r["period"], r["metric"]))


def _identity(row):
    return row["metric"], row["end"], row["period"][-1], row["currency"]


def bind_estimate_changes(previous, current, refreshed):
    old_rows = {r["ticker"]: r for r in previous.get("rows", [])}
    rows = []
    for row in current.get("rows", []):
        symbol = row["ticker"]
        old = old_rows.get(symbol)
        if not old or symbol not in refreshed:
            rows.append(row)
            continue
        old_data, new_data = old.get("analyst") or {}, row.get("analyst") or {}
        old_day = (
            old_data.get("asOf")
            or previous.get("rowClocks", {}).get(symbol, {}).get("lastSuccessfulAt")
            or previous.get("generated_at")
        )
        new_day = new_data.get("asOf") or current.get("generated_at")
        changes = []
        try:
            newer = datetime.fromisoformat(new_day) > datetime.fromisoformat(old_day)
        except (ValueError, TypeError):
            newer = False
        values = {_identity(item): item["mean"] for item in consensus_estimates(old_data)}
        retained = {_identity(item): item for item in old.get("estimateChanges", [])}
        for item in consensus_estimates(new_data):
            key = _identity(item)
            before, after = values.get(key), item["mean"]
            if before is None:
                continue
            if before == after and key in retained:
                changes.append(retained[key])
            elif newer and before != after:
                delta = EstimateChange(
                    **{k: v for k, v in item.items() if k != "mean"},
                    previous=before,
                    current=after,
                    change=after - before,
                    previous_as_of=old_day,
                    current_as_of=new_day,
                )
                changes.append(delta.model_dump(mode="json", by_alias=False))
        rows.append({**row, "estimateChanges": changes})
    return {**current, "rows": rows}
