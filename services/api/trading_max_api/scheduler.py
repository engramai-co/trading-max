"""Schedule idempotent full-refresh jobs at configured local times."""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from .job_errors import JobConflict
from .models import JobRecord, NightlySchedule


class SchedulerJobs(Protocol):
    def list(self, limit: int = 20) -> list[JobRecord]: ...

    def submit(
        self,
        scope: str,
        *,
        skip_sync: bool,
        trigger: str,
        scheduled_for: datetime,
    ) -> JobRecord: ...


class NightlyScheduler:
    def __init__(
        self,
        jobs: SchedulerJobs,
        *,
        enabled: bool,
        timezone: str,
        local_times: tuple[str, ...],
        reconciliation_local_time: str | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.jobs = jobs
        self.enabled = enabled
        self.timezone_name = timezone
        self.zone = ZoneInfo(timezone)
        parsed_times: set[time] = set()
        for value in local_times:
            try:
                hour_text, minute_text = value.split(":", 1)
                parsed_times.add(time(hour=int(hour_text), minute=int(minute_text)))
            except (AttributeError, ValueError) as exc:
                raise ValueError(f"invalid full-refresh time: {value!r}") from exc
        if not parsed_times:
            raise ValueError("local_times must contain at least one HH:MM time")
        self.schedule_times = tuple(sorted(parsed_times))
        self.reconciliation_time = None
        if reconciliation_local_time is not None:
            try:
                hour_text, minute_text = reconciliation_local_time.split(":", 1)
                self.reconciliation_time = time(hour=int(hour_text), minute=int(minute_text))
            except (AttributeError, ValueError) as exc:
                raise ValueError(
                    f"invalid reconciliation time: {reconciliation_local_time!r}"
                ) from exc
            if self.reconciliation_time not in self.schedule_times:
                raise ValueError("reconciliation time must be one of the research schedule times")
        self._now = now or (lambda: datetime.now(UTC))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def local_time(self) -> str:
        return " · ".join(self.local_times)

    @property
    def local_times(self) -> tuple[str, ...]:
        return tuple(value.strftime("%H:%M") for value in self.schedule_times)

    def _scheduled_at(self, day: date, local_time: time) -> datetime:
        return datetime.combine(day, local_time, tzinfo=self.zone)

    def _slots_for_day(self, day: date) -> tuple[datetime, ...]:
        return tuple(self._scheduled_at(day, value) for value in self.schedule_times)

    def _nightly_jobs(self) -> list[JobRecord]:
        return [
            record
            for record in self.jobs.list(limit=5_000)
            if record.trigger in {"nightly", "research", "reconciliation"}
        ]

    def _latest_nightly_job(self) -> JobRecord | None:
        return next(iter(self._nightly_jobs()), None)

    def _attempt_for(self, slot: datetime) -> JobRecord | None:
        slot_utc = slot.astimezone(UTC)
        for record in self._nightly_jobs():
            scheduled_for = record.scheduled_for or record.created_at
            if scheduled_for.astimezone(UTC) == slot_utc:
                return record
        return None

    def _latest_due_slot(self, now: datetime) -> datetime | None:
        due = [slot for slot in self._slots_for_day(now.date()) if slot <= now]
        if due:
            return due[-1]
        # Catch up yesterday's final daily reconciliation after a restart
        # before the first research slot. Older missed slots are never replayed.
        return self._slots_for_day(now.date() - timedelta(days=1))[-1]

    def _next_future_slot(self, now: datetime) -> datetime:
        upcoming = [slot for slot in self._slots_for_day(now.date()) if slot > now]
        if upcoming:
            return upcoming[0]
        return self._slots_for_day(now.date() + timedelta(days=1))[0]

    def status(self) -> NightlySchedule:
        last_job = self._latest_nightly_job()
        if not self.enabled:
            return NightlySchedule(
                enabled=False,
                timezone=self.timezone_name,
                local_time=self.local_time,
                local_times=list(self.local_times),
                last_job=last_job,
            )

        now = self._now().astimezone(self.zone)
        latest_due = self._latest_due_slot(now)
        if latest_due is not None and self._attempt_for(latest_due) is None:
            next_run = now
        else:
            next_run = self._next_future_slot(now)
        return NightlySchedule(
            enabled=True,
            timezone=self.timezone_name,
            local_time=self.local_time,
            local_times=list(self.local_times),
            next_run_at=next_run.astimezone(UTC),
            last_job=last_job,
        )

    def _tick(self) -> float:
        if not self.enabled:
            return 3600.0
        now = self._now().astimezone(self.zone)
        scheduled = self._latest_due_slot(now)
        if scheduled is not None and self._attempt_for(scheduled) is None:
            try:
                legacy = self.reconciliation_time is None
                reconciliation = self.reconciliation_time == scheduled.time()
                self.jobs.submit(
                    "all" if legacy or reconciliation else "research",
                    skip_sync=not (legacy or reconciliation),
                    trigger=(
                        "nightly"
                        if legacy
                        else ("reconciliation" if reconciliation else "research")
                    ),
                    scheduled_for=scheduled.astimezone(UTC),
                )
            except JobConflict:
                return 30.0
            return 30.0

        next_run = self._next_future_slot(now)
        return max(1.0, min((next_run - now).total_seconds(), 3600.0))

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                delay = self._tick()
            except Exception:
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
            name="trading_max-nightly",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
