"""Generate bounded, evidence-linked readings and cache only complete results."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, UsageLimits
from trading_max.infrastructure import SqliteDatabase

from .deps import AssistantDeps
from .roles import PageRole, ReadingLine, RoleContext, RoleReading
from .runtime import error_code
from .service import RUN_TIMEOUT_SECONDS, AssistantService, AssistantUnavailable

DAILY_BRIEF_LIMIT = 12


class Selection(BaseModel):
    # The model selects the most relevant observations. Each figure, wording and
    # source travel together and cannot be rewritten into a different claim.
    indices: list[int] = Field(min_length=2, max_length=4)


class ReadingEvent(BaseModel):
    type: Literal["reading", "lines", "result", "error", "empty"]
    reading: RoleReading | None = None
    lines: list[ReadingLine] | None = None
    code: str | None = None

    def encode(self) -> str:
        return self.model_dump_json(by_alias=True, exclude_none=True) + "\n"


@dataclass
class ReadingService:
    assistant: AssistantService
    database: SqliteDatabase

    def cached(
        self, role: PageRole, context: RoleContext, version: str | None, *, scheduled: bool = False
    ) -> RoleReading | None:
        key = (
            ("scheduled:" + role.cache_id) if scheduled or version is None else role.cache_id,
            role.object_key(context),
        )
        with self.database.read() as db:
            if version is None:
                row = db.execute(
                    "SELECT reading_json FROM assistant_readings WHERE role=? AND object_key=? ORDER BY as_of DESC LIMIT 1",
                    key,
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT reading_json FROM assistant_readings WHERE role=? AND object_key=? AND version=?",
                    (*key, version),
                ).fetchone()
        return RoleReading.model_validate_json(row[0]) if row else None

    def reserve(self, day: str, role: PageRole, context: RoleContext, slot: str) -> bool:
        with self.database.transaction(immediate=True) as db:
            db.execute(
                "DELETE FROM assistant_brief_attempts WHERE day < date(?, '-14 days')", (day,)
            )
            count = db.execute(
                "SELECT COUNT(*) FROM assistant_brief_attempts WHERE day=?", (day,)
            ).fetchone()[0]
            if count >= DAILY_BRIEF_LIMIT:
                return False
            return bool(
                db.execute(
                    "INSERT OR IGNORE INTO assistant_brief_attempts VALUES (?, ?, ?, ?)",
                    (day, role.id, role.object_key(context), slot),
                ).rowcount
            )

    def attempted(self, role: PageRole, context: RoleContext, slot: str) -> bool:
        with self.database.read() as db:
            return (
                db.execute(
                    "SELECT 1 FROM assistant_brief_attempts WHERE role=? AND object_key=? AND slot=?",
                    (role.id, role.object_key(context), slot),
                ).fetchone()
                is not None
            )

    async def events(
        self,
        role: PageRole,
        context: RoleContext,
        deps: AssistantDeps,
        *,
        scheduled: bool = False,
        cached_only: bool = False,
        latest: bool = False,
        match_data_version: bool = False,
        permitted: Callable[[], bool] = lambda: True,
        reserve: Callable[[], bool] = lambda: True,
    ) -> AsyncIterator[ReadingEvent]:
        status = await self.assistant.status()
        if not status["ready"]:
            yield ReadingEvent(type="error", code=status.get("code") or "assistant_unavailable")
            return
        try:
            tools = role.reader(deps, context)
            version = deps.snapshot_id
            # A material-data digest belongs to the displayed statements or estimates.
            # A scheduled digest for a previous revision cannot describe a new result.
            material = role.data_version is not None and (not latest or match_data_version)
            if material and version:
                version = await asyncio.to_thread(role.data_version, tools, context)
        except (ModelRetry, ValueError):
            yield ReadingEvent(type="error", code="assistant_context_invalid")
            return
        if (not latest or material) and not version:
            yield ReadingEvent(type="empty")
            return
        saved = self.cached(
            role,
            context,
            None if latest and not material else version,
            scheduled=scheduled or latest,
        )
        if saved:
            yield ReadingEvent(type="result", reading=saved)
            return
        if cached_only or not deps.manifest or not version:
            yield ReadingEvent(type="empty")
            return
        key = (
            ("scheduled:" + role.cache_id) if scheduled else role.cache_id,
            role.object_key(context),
            version,
        )
        reservation = "reading:" + json.dumps(key)
        try:
            self.assistant.claim(reservation)
        except HTTPException:
            yield ReadingEvent(type="error", code="assistant_busy")
            return
        try:
            yield ReadingEvent(type="reading")
            facts = await asyncio.to_thread(role.facts, tools, context)
            tools.attach_evidence(facts)
            if len(facts) < 2:
                yield ReadingEvent(type="empty")
                return
            if not permitted():
                yield ReadingEvent(type="error", code="assistant_disabled")
                return
            bind = self.assistant.bind_background_model if scheduled else self.assistant.bind_model
            if bind is None:
                yield ReadingEvent(type="error", code="assistant_disabled")
                return
            bound = await bind()
            if not permitted() or not reserve():
                yield ReadingEvent(type="error", code="assistant_disabled")
                return
            agent = Agent(output_type=Selection, instructions=role.prompt, retries=1)
            prompt = json.dumps(
                [
                    {"index": i, "section": fact.section, "observation": fact.en}
                    for i, fact in enumerate(facts)
                ],
                ensure_ascii=False,
            )
            async with (
                bound.model,
                agent.run_stream(
                    prompt,
                    model=bound.model,
                    model_settings=bound.settings,
                    cancellation_token=bound.cancellation_token,
                    usage_limits=UsageLimits(request_limit=2),
                    timeout=RUN_TIMEOUT_SECONDS,
                ) as stream,
            ):
                emitted: list[int] = []
                async for partial in stream.stream_output():
                    # The last integer may still be receiving digits. Only send
                    # complete, valid tool-backed lines to the browser.
                    complete = partial.indices[:-1]
                    if (
                        complete != emitted
                        and len(set(complete)) == len(complete)
                        and all(0 <= i < len(facts) for i in complete)
                    ):
                        if not permitted():
                            yield ReadingEvent(type="error", code="assistant_disabled")
                            return
                        emitted = complete
                        yield ReadingEvent(type="lines", lines=[facts[i] for i in complete])
                indices = (await stream.get_output()).indices
            if len(set(indices)) != len(indices) or any(i < 0 or i >= len(facts) for i in indices):
                yield ReadingEvent(type="error", code="provider_invalid_output")
                return
            sections = {fact.section for fact in facts if fact.section}
            lines = [facts[i] for i in indices]
            if len(sections) <= 4 and not sections.issubset({line.section for line in lines}):
                yield ReadingEvent(type="error", code="provider_invalid_output")
                return
            reading = RoleReading(
                role=role.id,
                version=version,
                snapshot_id=deps.snapshot_id,
                as_of=deps.manifest.created_at,
                lines=lines,
            )
            if not permitted() or not (await self.assistant.status())["ready"]:
                yield ReadingEvent(type="error", code="assistant_unavailable")
                return
            with self.database.transaction(immediate=True) as db:
                db.execute(
                    "INSERT OR REPLACE INTO assistant_readings VALUES (?, ?, ?, ?, ?)",
                    (*key, reading.as_of.isoformat(), reading.model_dump_json(by_alias=True)),
                )
                db.execute(
                    "DELETE FROM assistant_readings WHERE role=? AND object_key=? AND version NOT IN (SELECT version FROM assistant_readings WHERE role=? AND object_key=? ORDER BY as_of DESC LIMIT 16)",
                    (*key[:2], *key[:2]),
                )
            yield ReadingEvent(type="result", reading=reading)
        except AssistantUnavailable as exc:
            yield ReadingEvent(type="error", code=exc.code)
        except Exception as exc:
            yield ReadingEvent(type="error", code=error_code(exc))
        finally:
            self.assistant.release(reservation)
