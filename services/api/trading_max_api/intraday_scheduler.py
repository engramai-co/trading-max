"""Idempotent ten-minute scheduler for lightweight account-value anchors."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from .job_errors import JobConflict
from .models import IntradaySchedule, JobRecord, JobStatus, PerformanceSchedule

LOGGER = logging.getLogger(__name__)


class IntradaySchedulerJobs(Protocol):
    def list(self, limit: int = 20) -> list[JobRecord]: ...

    def submit(
        self,
        scope: str,
        *,
        skip_sync: bool,
        trigger: str,
        scheduled_for: datetime,
    ) -> JobRecord: ...


def _clock(value: str) -> time:
    try:
        hour_text, minute_text = value.split(":", 1)
        parsed = time(hour=int(hour_text), minute=int(minute_text))
    except (AttributeError, ValueError) as exc:
        raise ValueError(f"invalid intraday time: {value!r}") from exc
    return parsed


class IntradayScheduler:
    """Submit at most one current-slot job and never replay missed slots."""

    def __init__(
        self,
        jobs: IntradaySchedulerJobs,
        *,
        enabled: bool,
        timezone: str,
        interval_seconds: int,
        window_start: str,
        window_end: str,
        weekdays: tuple[int, ...],
        scope: str = "intraday",
        trigger: str = "intraday",
        legacy_triggers: tuple[str, ...] = (),
        performance: bool = False,
        should_submit: Callable[[], bool] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if interval_seconds < 60:
            raise ValueError("interval_seconds must be at least 60")
        self.jobs = jobs
        self.enabled = enabled
        self.timezone_name = timezone
        self.zone = ZoneInfo(timezone)
        self.interval_seconds = interval_seconds
        self.window_start = _clock(window_start)
        self.window_end = _clock(window_end)
        if self.window_start > self.window_end or (
            self.window_start == self.window_end != time(0, 0)
        ):
            raise ValueError(
                "intraday window start must be before its end; 00:00 to 00:00 means 24 hours"
            )
        self.full_day = self.window_start == self.window_end
        self.weekdays = tuple(sorted(set(weekdays)))
        if not self.weekdays or any(day not in range(1, 8) for day in self.weekdays):
            raise ValueError("weekdays must contain ISO weekdays from 1 to 7")
        self.scope = scope
        self.trigger = trigger
        self.triggers = (trigger, *legacy_triggers)
        self.performance = performance
        self.should_submit = should_submit
        self._material_change_triggered = False
        self._now = now or (lambda: datetime.now(UTC))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_observed_job_id: str | None = None
        self._last_error: str | None = None
        self._consecutive_failures = 0
        self._submitted_count = 0
        self._skipped_busy_count = 0

    @property
    def window_label(self) -> tuple[str, str]:
        return (
            self.window_start.strftime("%H:%M"),
            self.window_end.strftime("%H:%M"),
        )

    def _in_window(self, local: datetime) -> bool:
        return local.isoweekday() in self.weekdays and (
            self.full_day or self.window_start <= local.time() < self.window_end
        )

    def _window_start(self, day: date) -> datetime:
        return datetime.combine(day, self.window_start, tzinfo=self.zone)

    def _next_window(self, local: datetime) -> datetime:
        for offset in range(8):
            candidate_date = local.date() + timedelta(days=offset)
            if candidate_date.isoweekday() in self.weekdays:
                start = self._window_start(candidate_date)
                if offset > 0 or local < start:
                    return start
        return self._window_start(local.date() + timedelta(days=8))

    def _floor_slot(self, local: datetime) -> datetime:
        start = self._window_start(local.date())
        elapsed = max(0, int((local - start).total_seconds()))
        bucket = elapsed - elapsed % self.interval_seconds
        return start + timedelta(seconds=bucket)

    def _next_boundary(self, local: datetime) -> datetime:
        return self._floor_slot(local) + timedelta(seconds=self.interval_seconds)

    def _intraday_jobs(self) -> list[JobRecord]:
        return [record for record in self.jobs.list(limit=5_000) if record.trigger in self.triggers]

    def _active_full_job(self) -> JobRecord | None:
        latest_refreshes = getattr(self.jobs, "latest_refreshes", None)
        if callable(latest_refreshes):
            latest, _intraday = latest_refreshes()
            if latest is not None and latest.status in {JobStatus.QUEUED, JobStatus.RUNNING}:
                return latest
            return None
        return next(
            (
                record
                for record in self.jobs.list(limit=5_000)
                if record.status in {JobStatus.QUEUED, JobStatus.RUNNING}
                and record.trigger not in {"intraday", "live"}
            ),
            None,
        )

    def _intraday_summary(self) -> tuple[JobRecord | None, dict[str, int]]:
        summary = getattr(self.jobs, "trigger_summary", None)
        if callable(summary):
            latest_jobs: list[JobRecord] = []
            counts: dict[str, int] = {}
            for trigger in self.triggers:
                latest, trigger_counts = summary(trigger)
                if latest is not None:
                    latest_jobs.append(latest)
                for status, count in trigger_counts.items():
                    counts[status] = counts.get(status, 0) + count
            return (
                max(latest_jobs, key=lambda record: record.created_at) if latest_jobs else None,
                counts,
            )
        jobs = self._intraday_jobs()
        counts = {
            status.value: sum(record.status == status for record in jobs) for status in JobStatus
        }
        return (next(iter(jobs), None), counts)

    def _attempt_for(self, slot: datetime) -> JobRecord | None:
        slot_utc = slot.astimezone(UTC)
        latest, _counts = self._intraday_summary()
        if (
            latest is not None
            and latest.scheduled_for is not None
            and latest.scheduled_for.astimezone(UTC) == slot_utc
        ):
            return latest
        return None

    def _observe_latest(self, latest: JobRecord | None = None) -> JobRecord | None:
        if latest is None:
            latest, _counts = self._intraday_summary()
        if latest is None or latest.job_id == self._last_observed_job_id:
            return latest
        self._last_observed_job_id = latest.job_id
        if latest.status in {JobStatus.FAILED, JobStatus.INTERRUPTED}:
            self._consecutive_failures += 1
            self._last_error = latest.error
            LOGGER.warning(
                "intraday slot failed",
                extra={
                    "job_id": latest.job_id,
                    "scheduled_for": latest.scheduled_for,
                    "consecutive_failures": self._consecutive_failures,
                },
            )
            if self._consecutive_failures >= 3:
                LOGGER.error(
                    "intraday refresh has reached the failure alert threshold",
                    extra={"consecutive_failures": self._consecutive_failures},
                )
        elif latest.status == JobStatus.SUCCEEDED:
            self._consecutive_failures = 0
            self._last_error = None
        return latest

    def status(self) -> IntradaySchedule:
        start_label, end_label = self.window_label
        latest, counts = self._intraday_summary()
        last_job = self._observe_latest(latest)
        succeeded_count = counts.get(JobStatus.SUCCEEDED.value, 0)
        failed_count = counts.get(JobStatus.FAILED.value, 0) + counts.get(
            JobStatus.INTERRUPTED.value,
            0,
        )
        # The current live snapshot producer deliberately marks every anchor
        # unverified. Keep this metric explicit so a future transaction-flow
        # provider can replace it with artifact-level coverage inspection.
        flow_unverified_count = succeeded_count
        submitted_count = sum(counts.values())
        if not self.enabled:
            model = PerformanceSchedule if self.performance else IntradaySchedule
            return model(
                enabled=False,
                timezone=self.timezone_name,
                interval_seconds=self.interval_seconds,
                window_start=start_label,
                window_end=end_label,
                weekdays=list(self.weekdays),
                last_job=last_job,
                consecutive_failures=self._consecutive_failures,
                submitted_count=submitted_count,
                succeeded_count=succeeded_count,
                failed_count=failed_count,
                flow_unverified_count=flow_unverified_count,
                skipped_busy_count=self._skipped_busy_count,
                last_error=self._last_error,
                **(
                    {"material_change_triggered": self._material_change_triggered}
                    if self.performance
                    else {}
                ),
            )
        now = self._now().astimezone(self.zone)
        if not self._in_window(now):
            next_run = self._next_window(now)
        else:
            slot = self._floor_slot(now)
            next_run = (
                self._next_boundary(now)
                if self._attempt_for(slot) is not None or self._active_full_job() is not None
                else slot
            )
        model = PerformanceSchedule if self.performance else IntradaySchedule
        return model(
            enabled=True,
            timezone=self.timezone_name,
            interval_seconds=self.interval_seconds,
            window_start=start_label,
            window_end=end_label,
            weekdays=list(self.weekdays),
            next_run_at=next_run.astimezone(UTC),
            last_job=last_job,
            consecutive_failures=self._consecutive_failures,
            submitted_count=submitted_count,
            succeeded_count=succeeded_count,
            failed_count=failed_count,
            flow_unverified_count=flow_unverified_count,
            skipped_busy_count=self._skipped_busy_count,
            last_error=self._last_error,
            **(
                {"material_change_triggered": self._material_change_triggered}
                if self.performance
                else {}
            ),
        )

    def _tick(self) -> float:
        if not self.enabled:
            return 3600.0
        now = self._now().astimezone(self.zone)
        if not self._in_window(now):
            next_run = self._next_window(now)
            return max(1.0, min((next_run - now).total_seconds(), 3600.0))

        slot = self._floor_slot(now)
        if self._attempt_for(slot) is None:
            if self.should_submit is not None and not self.should_submit():
                self._material_change_triggered = False
                return max(
                    1.0,
                    min((self._next_boundary(now) - now).total_seconds(), 3600.0),
                )
            self._material_change_triggered = False
            if self._active_full_job() is not None:
                self._skipped_busy_count += 1
                LOGGER.info(
                    "intraday slot skipped because a full refresh has priority",
                    extra={"slot": slot.astimezone(UTC)},
                )
            else:
                try:
                    self.jobs.submit(
                        self.scope,
                        skip_sync=self.scope == "performance",
                        trigger=self.trigger,
                        scheduled_for=slot.astimezone(UTC),
                    )
                except JobConflict:
                    self._skipped_busy_count += 1
                    LOGGER.info(
                        "intraday slot skipped because another job is active",
                        extra={"slot": slot.astimezone(UTC)},
                    )
                else:
                    self._submitted_count += 1
                    LOGGER.info(
                        "intraday slot submitted",
                        extra={"slot": slot.astimezone(UTC)},
                    )
        next_boundary = self._next_boundary(now)
        return max(1.0, min((next_boundary - now).total_seconds(), 3600.0))

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                delay = self._tick()
            except Exception:
                LOGGER.exception("intraday scheduler tick failed")
                delay = 60.0
            self._wake.wait(delay)
            self._wake.clear()

    def configure(self, *, enabled: bool) -> None:
        self.enabled = bool(enabled)
        self._wake.set()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="trading_max-intraday",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


__all__ = ["IntradayScheduler"]
