"""Bounded broker-value anchors and safe intraday return semantics."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import Field

from trading_max.domain import DomainModel

FlowStatus = Literal["verified", "unverified"]


class IntradayAnchor(DomainModel):
    """One timestamped account-value observation."""

    observed_at: datetime
    bucket_at: datetime
    invest_value_gbp: float = Field(ge=0)
    isa_value_gbp: float = Field(ge=0)
    total_value_gbp: float = Field(ge=0)
    invest_cash_gbp: float = Field(ge=0)
    isa_cash_gbp: float = Field(ge=0)
    external_flow_gbp: float | None = None
    flow_status: FlowStatus = "unverified"
    source_artifact_ids: list[str] = Field(default_factory=list)


class IntradayAnchorSeries(DomainModel):
    """Bounded rolling series stored as one content-addressed artifact."""

    schema_version: int = 1
    generated_at: datetime
    interval_seconds: int = Field(gt=0)
    retention_days: int = Field(gt=0)
    points: list[IntradayAnchor] = Field(default_factory=list)


def _timestamp(value: Any, *, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"invalid {field}: {value!r}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(UTC)


def floor_bucket(value: datetime, interval_seconds: int) -> datetime:
    """Floor an aware timestamp to a deterministic UTC interval bucket."""

    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be positive")
    value = _timestamp(value, field="timestamp")
    epoch = int(value.timestamp())
    return datetime.fromtimestamp(
        epoch - epoch % interval_seconds,
        tz=UTC,
    )


def _money(account: Mapping[str, Any], key: str) -> float:
    if key not in account or account[key] is None:
        raise ValueError(f"account field {key!r} is missing")
    try:
        value = float(account[key])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"account field {key!r} is invalid") from exc
    if value < 0:
        raise ValueError(f"account field {key!r} must not be negative")
    return value


def append_intraday_anchor(
    previous: Mapping[str, Any] | None,
    accounts: Mapping[str, Mapping[str, Any]],
    *,
    source_artifact_ids: Sequence[str],
    interval_seconds: int = 600,
    retention_days: int = 40,
    generated_at: datetime | None = None,
) -> IntradayAnchorSeries:
    """Insert or replace one bucket and retain a bounded rolling series.

    The live Trading 212 snapshot does not include a verified transaction
    stream, so this producer marks every live anchor ``unverified``.  That is
    deliberate: the UI may plot broker-native value history, but must not
    present a cash-flow-affected value change as TWR.
    """

    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be positive")
    if retention_days <= 0:
        raise ValueError("retention_days must be positive")
    invest = accounts.get("A")
    isa = accounts.get("B")
    if not isinstance(invest, Mapping) or not isinstance(isa, Mapping):
        raise ValueError("intraday anchors require Invest and ISA snapshots")

    invest_value = _money(invest, "total_value_gbp")
    isa_value = _money(isa, "total_value_gbp")
    invest_fetched = _timestamp(invest.get("fetched_at"), field="Invest fetched_at")
    isa_fetched = _timestamp(isa.get("fetched_at"), field="ISA fetched_at")
    observed_at = max(invest_fetched, isa_fetched)
    current = IntradayAnchor(
        observed_at=observed_at,
        bucket_at=floor_bucket(observed_at, interval_seconds),
        invest_value_gbp=invest_value,
        isa_value_gbp=isa_value,
        total_value_gbp=invest_value + isa_value,
        invest_cash_gbp=_money(invest, "cash_gbp"),
        isa_cash_gbp=_money(isa, "cash_gbp"),
        external_flow_gbp=None,
        flow_status="unverified",
        source_artifact_ids=list(dict.fromkeys(source_artifact_ids)),
    )

    prior = (
        IntradayAnchorSeries.model_validate(previous)
        if previous is not None
        else IntradayAnchorSeries(
            generated_at=observed_at,
            interval_seconds=interval_seconds,
            retention_days=retention_days,
        )
    )
    if prior.interval_seconds != interval_seconds:
        raise ValueError("intraday anchor interval changed; migrate the existing series first")
    # Retention is storage policy, not part of an anchor's identity.  A policy
    # change can therefore be migrated safely in place: existing observations
    # are preserved when the window grows and pruned by the normal cutoff when
    # it shrinks.  Unlike an interval change, no timestamp rebucketing is
    # required.
    latest_bucket = max((point.bucket_at for point in prior.points), default=None)
    if latest_bucket is not None and current.bucket_at < latest_bucket:
        raise ValueError("intraday anchor is older than the latest retained bucket")

    by_bucket = {point.bucket_at: point for point in prior.points}
    by_bucket[current.bucket_at] = current
    cutoff = observed_at - timedelta(days=retention_days)
    points = sorted(
        (point for point in by_bucket.values() if point.bucket_at >= cutoff),
        key=lambda point: point.bucket_at,
    )
    return IntradayAnchorSeries(
        generated_at=_timestamp(generated_at or observed_at, field="generated_at"),
        interval_seconds=interval_seconds,
        retention_days=retention_days,
        points=points,
    )


def verified_period_return(
    starting_value: float,
    ending_value: float,
    external_flow_gbp: float | None,
    flow_status: FlowStatus,
) -> float | None:
    """Return a period return only when its cash-flow input is verified."""

    if flow_status != "verified" or external_flow_gbp is None:
        return None
    if starting_value <= 0 or ending_value < 0:
        raise ValueError("period values must be non-negative and start above zero")
    return (ending_value - external_flow_gbp) / starting_value - 1.0


def verified_intraday_chain(
    points: Sequence[IntradayAnchor],
) -> list[dict[str, float | str | None]]:
    """Build a TWR/drawdown chain without silently treating unknown flow as zero."""

    result: list[dict[str, float | str | None]] = []
    wealth = 1.0
    peak = 1.0
    for index, point in enumerate(points):
        if index:
            previous = points[index - 1]
            period = verified_period_return(
                previous.total_value_gbp,
                point.total_value_gbp,
                point.external_flow_gbp,
                point.flow_status,
            )
            if period is None:
                result.append(
                    {
                        "observedAt": point.observed_at.isoformat(),
                        "twr": None,
                        "drawdown": None,
                    }
                )
                continue
            wealth *= 1.0 + period
            peak = max(peak, wealth)
        result.append(
            {
                "observedAt": point.observed_at.isoformat(),
                "twr": wealth - 1.0,
                "drawdown": wealth / peak - 1.0,
            }
        )
    return result


__all__ = [
    "FlowStatus",
    "IntradayAnchor",
    "IntradayAnchorSeries",
    "append_intraday_anchor",
    "floor_bucket",
    "verified_intraday_chain",
    "verified_period_return",
]
