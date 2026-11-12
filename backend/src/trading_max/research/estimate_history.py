"""Point-in-time Yahoo earnings estimates, independent of the research lenses."""

from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pydantic import AwareDatetime, Field

from trading_max.domain import DomainModel
from trading_max.infrastructure import (
    ArtifactIntegrityError,
    SnapshotStore,
    SqliteDatabase,
)
from trading_max.reference.quote_units import major_quote_unit

from .facts import number
from .listing import quote_listing

LOGGER = logging.getLogger(__name__)
FUNDAMENTALS_KEY = "research/fundamentals.json"
ANALYST_KEY = "research/analyst.json"
ESTIMATE_KEYS = frozenset({FUNDAMENTALS_KEY, ANALYST_KEY})
SCHEDULED_RESEARCH_TRIGGERS = frozenset({"research", "reconciliation", "nightly"})
MAX_HISTORY_ROWS = 2_000
_RECOVERY_MANIFEST_LIMIT = 2_048
_RECOVERY_PUBLICATION_LIMIT = 32

type EstimatePeriod = Literal["0q", "+1q", "0y", "+1y"]
_PERIODS: tuple[EstimatePeriod, ...] = ("0q", "+1q", "0y", "+1y")


class ConsensusEstimate(DomainModel):
    period: EstimatePeriod
    period_end: date | None = None
    currency: str | None = None
    mean_eps: float | None = None
    low_eps: float | None = None
    high_eps: float | None = None
    analyst_count: int | None = Field(default=None, ge=0)
    growth: float | None = None


class EstimateObservation(DomainModel):
    ticker: str
    listing: str | None = None
    currency: str | None = None
    quote_unit: str | None = None
    reporting_currency: str | None = None
    observed_at: AwareDatetime
    provider: Literal["yahoo-finance"] = "yahoo-finance"
    provider_as_of: str | None = None
    price: float | None = None
    price_as_of: AwareDatetime | None = None
    forward_pe: float | None = Field(default=None, alias="forwardPE")
    forward_eps: float | None = None
    trailing_pe: float | None = Field(default=None, alias="trailingPE")
    trailing_eps: float | None = None
    consensus: list[ConsensusEstimate] = Field(default_factory=list)
    recovered: bool = False


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def _records(value: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(value, list):
        yield from (item for item in value if isinstance(item, Mapping))


def _utc_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _timestamp(value: Any) -> datetime | None:
    seconds = number(value)
    if seconds is not None and seconds > 0:
        try:
            return datetime.fromtimestamp(seconds, UTC)
        except (OSError, OverflowError, ValueError):
            pass
    return None


def _fresh_rows(batch: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """Read this batch's rows only, excluding failed and retained observations."""
    generated_at = batch.get("generated_at")
    clocks = batch.get("rowClocks")
    result = {}
    for row in _records(batch.get("rows")):
        ticker = _text(row.get("ticker"))
        if ticker is None:
            continue
        ticker = ticker.upper()
        if clocks is not None:
            clock = clocks.get(ticker) if isinstance(clocks, Mapping) else None
            if (
                not isinstance(clock, Mapping)
                or clock.get("state") != "available"
                or not generated_at
                or clock.get("fetchedAt") != generated_at
            ):
                continue
        result[ticker] = row
    return result


def _consensus(analyst: Mapping[str, Any]) -> list[ConsensusEstimate]:
    estimates = {
        _text(row.get("period") or row.get("index")): row
        for row in _records(analyst.get("earningsEstimate"))
    }
    fiscal_periods = {
        _text(row.get("period")): row for row in _records(analyst.get("fiscalPeriods"))
    }
    result = []
    for period in _PERIODS:
        row = estimates.get(period)
        if row is None:
            continue
        fiscal = fiscal_periods.get(period, {})
        raw_end = _text(row.get("endDate")) or _text(fiscal.get("endDate"))
        try:
            period_end = date.fromisoformat(raw_end) if raw_end else None
        except ValueError:
            period_end = None
        count = number(row.get("numberOfAnalysts"))
        result.append(
            ConsensusEstimate(
                period=period,
                period_end=period_end,
                currency=_text(row.get("currency")) or _text(fiscal.get("earningsCurrency")),
                mean_eps=number(row.get("avg")),
                low_eps=number(row.get("low")),
                high_eps=number(row.get("high")),
                analyst_count=int(count)
                if count is not None and count >= 0 and count.is_integer()
                else None,
                growth=number(row.get("growth")),
            )
        )
    return result


def estimate_observations(
    fundamentals: Mapping[str, Any],
    analyst: Mapping[str, Any],
    *,
    observed_at: datetime,
    recovered: bool = False,
) -> Iterable[EstimateObservation]:
    """Join successful responses for the exact listing; never substitute stale data."""
    analyst_rows = _fresh_rows(analyst)
    for ticker, row in _fresh_rows(fundamentals).items():
        estimates = analyst_rows.get(ticker, {}).get("analyst")
        metrics = row.get("metrics")
        if not isinstance(metrics, Mapping) or not isinstance(estimates, Mapping):
            continue
        consensus = _consensus(estimates)
        vendor = {
            key: number(metrics.get(key))
            for key in ("forwardPE", "forwardEps", "trailingPE", "trailingEps")
        }
        if all(value is None for value in vendor.values()) and not any(
            any(
                value is not None
                for value in (
                    item.mean_eps,
                    item.low_eps,
                    item.high_eps,
                    item.analyst_count,
                    item.growth,
                )
            )
            for item in consensus
        ):
            continue
        unit = _text(row.get("currency"))
        currency, divisor = major_quote_unit(unit)
        price = number(metrics.get("regularMarketPrice"))
        price = price if price is not None and price > 0 and unit else None
        yield EstimateObservation(
            ticker=ticker,
            listing=quote_listing(
                ticker,
                _text(metrics.get("fullExchangeName")),
                _text(metrics.get("exchangeTimezoneName")),
            ),
            currency=currency,
            quote_unit=unit,
            reporting_currency=_text(metrics.get("financialCurrency"))
            or _text(estimates.get("reportingCurrency")),
            observed_at=observed_at,
            provider_as_of=_text(estimates.get("providerAsOf")),
            price=price / divisor if price is not None else None,
            price_as_of=_timestamp(metrics.get("regularMarketTime")) if price is not None else None,
            consensus=consensus,
            recovered=recovered,
            **vendor,
        )


class EstimateHistory:
    """An append-only ledger in the same durable SQLite database as the worker."""

    def __init__(self, database: SqliteDatabase) -> None:
        self.database = database

    def append(self, observations: Iterable[EstimateObservation]) -> int:
        with self.database.transaction(immediate=True) as connection:
            return self._append(connection, observations)

    @staticmethod
    def _append(connection: sqlite3.Connection, observations: Iterable[EstimateObservation]) -> int:
        count = 0
        for observation in observations:
            observed_at = _utc_iso(observation.observed_at)
            payload = observation.model_dump_json(exclude={"observed_at"})
            previous = connection.execute(
                "SELECT observation_json FROM research_estimate_history WHERE ticker = ? "
                "AND observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1",
                (observation.ticker, observed_at),
            ).fetchone()
            if previous is not None and previous["observation_json"] == payload:
                continue
            connection.execute(
                "INSERT INTO research_estimate_history (ticker, observed_at, observation_json) "
                "VALUES (?, ?, ?)",
                (observation.ticker, observed_at, payload),
            )
            count += 1
        return count

    def list(self, ticker: str, *, limit: int) -> list[EstimateObservation]:
        limit = min(MAX_HISTORY_ROWS, max(1, limit))
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT observed_at, observation_json FROM research_estimate_history WHERE ticker = ? "
                "ORDER BY observed_at DESC, id DESC LIMIT ?",
                (ticker.strip().upper(), limit),
            ).fetchall()
        return [
            EstimateObservation.model_validate(
                {**json.loads(row["observation_json"]), "observedAt": row["observed_at"]}
            )
            for row in reversed(rows)
        ]

    def valuation_window(
        self, ticker: str, listing: str, *, cutoff: datetime
    ) -> list[EstimateObservation]:
        """Read a small exact-listing window without recovering or appending rows."""
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT observed_at, observation_json FROM research_estimate_history "
                "WHERE ticker = ? AND observed_at <= ? "
                "AND json_extract(observation_json, '$.listing') = ? "
                "AND length(CAST(observation_json AS BLOB)) <= 16384 "
                "ORDER BY observed_at DESC, id DESC LIMIT 16",
                (ticker, _utc_iso(cutoff), listing),
            ).fetchall()
        return [
            EstimateObservation.model_validate(
                {**json.loads(row["observation_json"]), "observedAt": row["observed_at"]}
            )
            for row in rows
        ]

    def recover(self, snapshots: SnapshotStore, *, before: datetime) -> int:
        """Seed once from recent immutable publications without touching their files."""
        with self.database.read() as connection:
            if connection.execute("SELECT 1 FROM research_estimate_recovery").fetchone():
                return 0
            first = connection.execute(
                "SELECT MIN(observed_at) FROM research_estimate_history"
            ).fetchone()[0]
        cutoff = min(before, datetime.fromisoformat(first)) if first else before
        recovered = list(_recoverable_observations(snapshots, before=cutoff))
        with self.database.transaction(immediate=True) as connection:
            if connection.execute("SELECT 1 FROM research_estimate_recovery").fetchone():
                return 0
            count = self._append(connection, recovered)
            connection.execute("INSERT INTO research_estimate_recovery VALUES (1)")
        return count


def _recoverable_observations(
    snapshots: SnapshotStore, *, before: datetime
) -> Iterable[EstimateObservation]:
    manifests = [
        stored.manifest
        for stored in snapshots.list(
            limit=_RECOVERY_MANIFEST_LIMIT, scan_limit=_RECOVERY_MANIFEST_LIMIT
        )
        if stored.manifest.scope in {"all", "research"} and stored.manifest.created_at < before
    ][:_RECOVERY_PUBLICATION_LIMIT]
    previous = None
    for manifest in reversed(manifests):
        # A publication must own both fetches. Other publications can inherit
        # the same immutable objects, even when their publication time changes.
        observed_at = manifest.created_at
        lower_bound = previous or (observed_at - timedelta(days=1))
        previous = observed_at
        refs = {ref.key: ref for ref in manifest.artifacts if ref.key in ESTIMATE_KEYS}
        if refs.keys() != ESTIMATE_KEYS or any(
            not lower_bound < ref.generated_at <= observed_at for ref in refs.values()
        ):
            continue
        try:
            fundamentals, analyst = (
                snapshots.artifacts.get_json(refs[key].artifact_id).payload
                for key in (FUNDAMENTALS_KEY, ANALYST_KEY)
            )
            if (
                fundamentals.get("artifact_type") != "fundamentals_research_batch"
                or analyst.get("artifact_type") != "analyst_research_batch"
            ):
                continue
            for key, payload in ((FUNDAMENTALS_KEY, fundamentals), (ANALYST_KEY, analyst)):
                generated_at = datetime.fromisoformat(payload["generated_at"])
                if not lower_bound < generated_at <= observed_at or (
                    refs[key].dependency_artifact_ids and not payload.get("rowClocks")
                ):
                    break
            else:
                yield from estimate_observations(
                    fundamentals, analyst, observed_at=observed_at, recovered=True
                )
        except (ArtifactIntegrityError, OSError, KeyError, TypeError, ValueError):
            LOGGER.warning("could not recover estimates from publication %s", manifest.run_id)
