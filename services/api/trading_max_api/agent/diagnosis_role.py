"""Explain a terminal update or stale publication without passing raw logs to a model."""

import re
from datetime import datetime, timedelta
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


# Public job labels and errors may contain provider details. Only stable stage names
# are mapped into assistant text.
STAGES = {
    "broker.sync": ("券商同步", "Broker sync"),
    "accounts.snapshot": ("账户快照", "Account snapshot"),
    "reference.security_master": ("证券分类", "Security classification"),
    "portfolio.lookthrough": ("持仓穿透", "Portfolio look-through"),
    "accounts.diluted_cost": ("摊薄成本", "Diluted cost"),
    "accounts.policy": ("账户策略", "Account policy"),
    "accounts.capital_recovery": ("本金回收", "Capital recovery"),
    "accounts.nav": ("账户净值", "Account valuation"),
    "accounts.intraday_nav": ("日内估值", "Intraday valuation"),
    "accounts.day_attribution": ("当日归因", "Daily attribution"),
    "accounts.cfd": ("差价合约账本", "CFD ledger"),
    "accounts.performance": ("账户绩效", "Account performance"),
    "accounts.review": ("账户复盘", "Account review"),
    "accounts.decisions": ("交易决策复盘", "Decision review"),
    "market.snapshot": ("市场报价", "Market prices"),
    "research.fund_prices": ("基金价格", "Fund prices"),
    "research.taxonomy": ("研究分类", "Research classification"),
    "research.technical": ("技术指标", "Technical indicators"),
    "research.options": ("期权", "Options"),
    "research.adr": ("美国存托凭证", "ADRs"),
    "research.fundamentals": ("基本面", "Fundamentals"),
    "research.financials": ("财务报表", "Financial statements"),
    "research.analyst": ("分析师共识", "Analyst consensus"),
    "research.valuation": ("估值", "Valuation"),
    "research.earnings": ("业绩", "Earnings"),
    "research.security_news": ("证券新闻", "Security news"),
    "research.macro_calendar": ("宏观日历", "Macro calendar"),
    "research.etf_depth": ("ETF 研究", "ETF research"),
    "snapshot.publish": ("发布快照", "Snapshot publication"),
}


def update_issue(ctx: tools.Context, args: DiagnosisContext):
    """Read a terminal update or stale snapshot and return only classified, verified facts."""
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
    if job.job_id != args.job or job.status not in {"failed", "interrupted"} or not job.finished_at:
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
            "failed_stages": [s.name for s in failed if s.name in STAGES],
            "attempts": job.attempts,
            "completed": sum(s.status == "succeeded" for s in job.stages),
            "stages": len(job.stages),
        }
    )


def diagnosis_anchor(read: RoleTools, context: DiagnosisContext):
    if context.issue == "stale":
        if manifest := read.deps.manifest:
            return manifest.run_id, manifest.created_at
        return None
    result = read.read(update_issue, context)
    if data := result.get("data"):
        return tools._short_id("job_", [context.job, data]), datetime.fromisoformat(
            data["finished_at"]
        )
    return None


def diagnosis_facts(read: RoleTools, context: DiagnosisContext):
    result = read.read(update_issue, context)
    data = result.get("data") or {}
    if not data:
        return []

    def add(section, zh, en, source="health"):
        return line(
            section,
            zh,
            en,
            result,
            source,
            "update_issue",
            metric=section,
            observed=data.get("finished_at") or data["last_publication"],
            **context.model_dump(exclude_none=True),
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
    attempts = data["attempts"]
    retry_zh = f" 共记录 {attempts} 次尝试。" if attempts else ""
    retry_en = (
        f" The job recorded {attempts} attempt{'s' if attempts > 1 else ''}." if attempts else ""
    )
    facts = [
        add(
            "status",
            f"本次更新于 {stamp} {zh}。{retry_zh}",
            f"The update {en} at {stamp}.{retry_en}",
        )
    ]
    stages = [STAGES[key] for key in data["failed_stages"]]
    if stages:
        zh_labels = "、".join(zh for zh, _ in stages)
        en_labels = ", ".join(en for _, en in stages)
        facts.append(
            add(
                "stages",
                f"{zh_labels}阶段失败，本次更新未能完成这些数据的刷新。",
                f"{en_labels} failed. This run did not finish updating that data.",
            )
        )
    else:
        facts.append(
            add(
                "stages",
                f"记录的 {data['stages']} 个阶段中有 {data['completed']} 个完成。",
                f"{data['completed']} of {data['stages']} recorded stages completed.",
            )
            if data["stages"]
            else add(
                "stages",
                "本次更新没有留下阶段记录。",
                "No stage detail was recorded for this update.",
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
    record_anchor=diagnosis_anchor,
)
