"""Observe successful publications from both embedded and external workers."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from trading_max.infrastructure import SqliteDatabase

from ..models import JobRecord
from .overview_roles import full_publication
from .readings import ReadingService
from .roles import BriefTarget, PageRole, RoleTools, role_registry

LOGGER = logging.getLogger("trading_max.assistant.briefs")
LONDON = ZoneInfo("Europe/London")


def completed_publications(database: SqliteDatabase) -> list[JobRecord]:
    """Read just the completed publication metadata, without expanding job stages or logs."""
    since = (datetime.now(UTC) - timedelta(days=2)).isoformat(timespec="microseconds")
    with database.read() as db:
        rows = db.execute(
            """SELECT job_id, scope, trigger, skip_sync, scheduled_for, status, created_at,
                      finished_at, snapshot_run_id, tickers_json FROM jobs
               WHERE status='succeeded' AND snapshot_run_id IS NOT NULL AND finished_at>=?
               AND trigger IN ('nightly','research','reconciliation','on_demand')
               ORDER BY finished_at DESC LIMIT 240""",
            (since,),
        ).fetchall()
    return [
        JobRecord.model_validate({**dict(row), "tickers": json.loads(row["tickers_json"])})
        for row in rows
    ]


@dataclass
class BriefWriter:
    readings: ReadingService
    permitted: Callable[[], bool]
    recent_jobs: Callable[[], list[JobRecord]]
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    async def tick(self) -> None:
        if not self.permitted():
            return
        now = self.clock()
        recent = await asyncio.to_thread(self.recent_jobs)
        if not recent:
            return
        roles = role_registry().values()
        for job in reversed(recent):
            # Only a recently completed update starts a publication-triggered role.
            if not job.finished_at or not now - timedelta(hours=1) <= job.finished_at <= now:
                continue
            if job.status != "succeeded" or job.trigger in {"intraday", "live", "performance"}:
                continue
            for role in roles:
                if role.weekly_fold:
                    continue
                if role.publication_targets and job.snapshot_run_id:
                    deps = self.readings.assistant.deps_for_run(role.page, LONDON.key)
                    try:
                        manifest = await asyncio.to_thread(
                            deps.store.load_manifest, job.snapshot_run_id
                        )
                    except FileNotFoundError:
                        continue
                    reader = RoleTools.pinned(replace(deps, manifest=manifest), role.allowed_tools)
                    targets = await asyncio.to_thread(role.publication_targets, job, reader)
                else:
                    targets = role.scheduled(job) if role.scheduled else []
                for target in targets:
                    await self.write(job, role, target)
        local = now.astimezone(LONDON)
        if local.weekday() != 5 or local.hour < 2:
            return
        fold = local.replace(hour=2, minute=0, second=0, microsecond=0)
        # Saturday 02:00 may have no coincident refresh. Use the latest
        # completed scheduled publication before the fold, including Friday's.
        cutoff = next(
            (
                j
                for j in recent
                if j.finished_at
                and j.snapshot_run_id
                and full_publication(j)
                and fold - timedelta(days=1) <= j.finished_at <= fold
            ),
            None,
        )
        if cutoff:
            for role in roles:
                if role.weekly_fold:
                    await self.write(
                        cutoff,
                        role,
                        BriefTarget(role.context_schema(), fold.date().isoformat()),
                    )

    async def write(self, job: JobRecord, role: PageRole, target: BriefTarget) -> None:
        if not job.snapshot_run_id:
            return
        if not self.permitted():
            return
        if self.readings.attempted(role, target.context, target.slot):
            return
        deps = self.readings.assistant.deps_for_run(role.page, LONDON.key)
        try:
            manifest = await asyncio.to_thread(deps.store.load_manifest, job.snapshot_run_id)
        except FileNotFoundError:
            return
        async for event in self.readings.events(
            role,
            target.context,
            replace(deps, manifest=manifest),
            scheduled=True,
            permitted=self.permitted,
            reserve=lambda: self.readings.reserve(
                self.clock().astimezone(LONDON).date().isoformat(),
                role,
                target.context,
                target.slot,
            ),
        ):
            if event.type == "error":
                LOGGER.info(
                    "Background brief deferred",
                    extra={"role_id": role.id, "error_code": event.code},
                )

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception as exc:
                LOGGER.warning(
                    "Could not check background briefs", extra={"error_type": type(exc).__name__}
                )
            await asyncio.sleep(30)
