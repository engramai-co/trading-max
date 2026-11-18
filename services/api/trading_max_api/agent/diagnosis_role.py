"""Explain a terminal update or stale publication without passing raw logs to a model."""

import re
from datetime import timedelta
from typing import Literal

from pydantic import Field, model_validator

from . import tools
from .overview_roles import LONDON, line
from .roles import PageRole, RoleContext, RoleTools


class DiagnosisContext(RoleContext):
    issue: Literal["job", "stale"]
    job: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def job_required(self):
        if bool(self.job) != (self.issue == "job"):
            raise ValueError("Choose the failed job or the stale publication")
        return self


def update_issue(ctx: tools.Context, args: DiagnosisContext):
    read = tools._Read(ctx.deps, "update_issue", args, "broker_total")
    read.account_codes("broker_total")
    if args.issue == "stale":
        if (
            not ctx.deps.manifest
            or not ctx.deps.captured_at
            or ctx.deps.captured_at - ctx.deps.manifest.created_at <= timedelta(days=1)
        ):
            return read.missing("publication_not_stale")
        return read.result(data={"last_publication": ctx.deps.manifest.created_at.isoformat()})
    if not ctx.deps.page_sources:
        return read.missing("job_unavailable")
    try:
        job = ctx.deps.page_sources.job(args.job)
    except FileNotFoundError:
        return read.missing("job_unavailable")
    if job.status not in {"failed", "interrupted"} or not job.finished_at:
        return read.missing("job_not_terminal")
    failed = [s for s in job.stages if s.status == "failed"]
    messages = [job.error or "", *(s.error or "" for s in failed)]
    mismatch = any(
        re.search(
            r"broker snapshot reconciliation failed: \{'positions_match_investments': False|position detail (?:at \d\d:\d\d UTC )?differs from the account summary",
            message,
        )
        for message in messages
    )
    return read.result(
        data={
            "finished_at": job.finished_at.astimezone(LONDON).isoformat(),
            "status": job.status,
            "failed_broker_reconciliation": mismatch,
            "completed": sum(s.status == "succeeded" for s in job.stages),
            "stages": len(job.stages),
        }
    )


def diagnosis_facts(read: RoleTools, context: DiagnosisContext):
    result = read.read(update_issue, context)
    data = result.get("data") or {}
    if not data:
        return []

    def add(section, zh, en, source="health"):
        return line(
            section, zh, en, result, source, "update_issue", **context.model_dump(exclude_none=True)
        )

    if context.issue == "stale":
        stamp = data["last_publication"]
        return [
            add(
                "publication",
                f"最近一次完整快照发布于 {stamp}。",
                f"The last complete snapshot was published at {stamp}.",
            ),
            add(
                "effect",
                "各页面保留上一次成功发布的数据。",
                "The workspace still shows the last successful publication.",
            ),
        ]
    stamp = data["finished_at"]
    zh, en = ("中断", "was interrupted") if data["status"] == "interrupted" else ("失败", "failed")
    facts = [add("status", f"本次更新于 {stamp} {zh}。", f"The update {en} at {stamp}.")]
    facts.append(
        add(
            "stages",
            f"记录的 {data['stages']} 个阶段中有 {data['completed']} 个完成。",
            f"{data['completed']} of {data['stages']} recorded stages completed.",
        )
        if data["stages"]
        else add(
            "stages", "本次更新没有留下阶段记录。", "No stage detail was recorded for this update."
        )
    )
    if data["failed_broker_reconciliation"]:
        facts.extend(
            [
                add(
                    "broker",
                    "券商持仓明细与账户汇总未对齐。",
                    "The broker’s position detail did not reconcile to its account summary.",
                    "broker",
                ),
                add(
                    "cause",
                    "通常是挂单还没成交，或资金刚投进 Pie。",
                    "Possible explanations include a pending order or cash recently added to a Pie.",
                    "inference",
                ),
            ]
        )
    return facts


DIAGNOSIS = PageRole(
    "diagnosis",
    "health",
    frozenset({"update_issue"}),
    DiagnosisContext,
    "Select every section once. A possible cause is an inference, never a diagnosis of an order or a promise about the next update.",
    diagnosis_facts,
)
