from __future__ import annotations

from datetime import UTC, datetime

import pytest
from trading_max.analytics.intraday import (
    IntradayAnchor,
    append_intraday_anchor,
    floor_bucket,
    verified_intraday_chain,
    verified_period_return,
)


def _accounts(at: str, invest: float = 100.0, isa: float = 200.0) -> dict:
    return {
        "A": {
            "fetched_at": at,
            "total_value_gbp": invest,
            "cash_gbp": 10.0,
        },
        "B": {
            "fetched_at": at,
            "total_value_gbp": isa,
            "cash_gbp": 20.0,
        },
    }


def test_floor_bucket_handles_hour_and_utc_midnight() -> None:
    assert floor_bucket(
        datetime(2026, 8, 8, 15, 29, 59, tzinfo=UTC),
        600,
    ) == datetime(2026, 8, 8, 15, 20, tzinfo=UTC)
    assert floor_bucket(
        datetime(2026, 8, 9, 0, 1, tzinfo=UTC),
        600,
    ) == datetime(2026, 8, 9, 0, tzinfo=UTC)


def test_retry_replaces_bucket_and_retention_is_bounded() -> None:
    first = append_intraday_anchor(
        None,
        _accounts("2026-08-01T20:00:02Z"),
        source_artifact_ids=["a", "b"],
        retention_days=2,
    )
    replaced = append_intraday_anchor(
        first.model_dump(mode="json", by_alias=False),
        _accounts("2026-08-01T20:09:59Z", invest=101.0),
        source_artifact_ids=["c", "d"],
        retention_days=2,
    )
    assert len(replaced.points) == 1
    assert replaced.points[0].invest_value_gbp == 101.0
    current = replaced
    for day in range(1, 4):
        current = append_intraday_anchor(
            current.model_dump(mode="json", by_alias=False),
            _accounts(f"2026-08-{1 + day:02d}T20:00:00Z"),
            source_artifact_ids=["a", "b"],
            retention_days=2,
        )
    assert current.points[0].observed_at >= datetime(2026, 8, 2, 20, tzinfo=UTC)
    assert current.points == sorted(current.points, key=lambda point: point.bucket_at)


def test_retention_policy_change_migrates_existing_series_in_place() -> None:
    previous = append_intraday_anchor(
        None,
        _accounts("2026-08-01T20:00:00Z"),
        source_artifact_ids=["a", "b"],
        retention_days=14,
    )

    migrated = append_intraday_anchor(
        previous.model_dump(mode="json", by_alias=False),
        _accounts("2026-08-02T20:00:00Z", invest=105.0),
        source_artifact_ids=["c", "d"],
        retention_days=40,
    )

    assert migrated.retention_days == 40
    assert len(migrated.points) == 2
    assert migrated.points[0] == previous.points[0]
    assert migrated.points[1].invest_value_gbp == 105.0


def test_out_of_order_anchor_is_rejected() -> None:
    series = append_intraday_anchor(
        None,
        _accounts("2026-08-08T20:10:00Z"),
        source_artifact_ids=[],
    )
    with pytest.raises(ValueError, match="older"):
        append_intraday_anchor(
            series.model_dump(mode="json", by_alias=False),
            _accounts("2026-08-08T20:00:00Z"),
            source_artifact_ids=[],
        )


def test_verified_flow_is_removed_and_unknown_flow_is_null() -> None:
    assert verified_period_return(100.0, 120.0, 10.0, "verified") == pytest.approx(0.10)
    assert verified_period_return(100.0, 120.0, None, "unverified") is None
    points = [
        IntradayAnchor(
            observed_at=datetime(2026, 8, 8, 10, tzinfo=UTC),
            bucket_at=datetime(2026, 8, 8, 10, tzinfo=UTC),
            invest_value_gbp=100,
            isa_value_gbp=100,
            total_value_gbp=200,
            invest_cash_gbp=0,
            isa_cash_gbp=0,
            flow_status="verified",
            external_flow_gbp=0,
        ),
        IntradayAnchor(
            observed_at=datetime(2026, 8, 8, 10, 10, tzinfo=UTC),
            bucket_at=datetime(2026, 8, 8, 10, 10, tzinfo=UTC),
            invest_value_gbp=110,
            isa_value_gbp=100,
            total_value_gbp=210,
            invest_cash_gbp=0,
            isa_cash_gbp=0,
            flow_status="unverified",
        ),
    ]
    assert verified_intraday_chain(points)[1]["twr"] is None
