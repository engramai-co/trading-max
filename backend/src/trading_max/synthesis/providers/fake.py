"""Deterministic fake provider for offline smoke tests."""

from __future__ import annotations

import time

from ..contracts import (
    AnalysisDefinition,
    JsonObject,
    LocalizedText,
    ProviderUsage,
    SynthesisEvidence,
    SynthesisResponse,
    SynthesisResult,
)


class FakeProvider:
    name = "fake"
    model = "trading_max-fake-v1"
    fake = True

    def analyze(
        self,
        definition: AnalysisDefinition,
        context: JsonObject,
    ) -> SynthesisResult:
        started = time.perf_counter()
        snapshot_id = str(context.get("snapshotRunId") or "unknown")
        ticker = str(context.get("ticker") or "portfolio")
        total = context.get("dashboard", {}).get("totalValueGbp", "—")
        response = SynthesisResponse(
            headline=LocalizedText(
                zh=f"{ticker} 的 {definition.analysis_id} 分析已绑定快照",
                en=f"{ticker} {definition.analysis_id} analysis is snapshot-bound",
            ),
            summary=LocalizedText(
                zh=f"本次离线 smoke analysis 只使用快照 {snapshot_id}，组合值为 {total}。",
                en=f"This offline smoke analysis uses only snapshot {snapshot_id}; portfolio value is {total}.",
            ),
            evidence=[
                SynthesisEvidence(
                    label=LocalizedText(zh="数据来源", en="Data source"),
                    detail=LocalizedText(
                        zh="结论与不可变快照使用同一输入版本。",
                        en="The conclusion and immutable snapshot use the same input version.",
                    ),
                    metric=snapshot_id,
                    source_refs=[f"snapshot:{snapshot_id}"],
                )
            ],
            counterpoints=[
                LocalizedText(
                    zh="单次快照不能证明持续趋势。",
                    en="One snapshot cannot establish a persistent trend.",
                )
            ],
            risks=[
                LocalizedText(
                    zh="数据新鲜度和覆盖范围仍需检查。",
                    en="Data freshness and coverage still need review.",
                )
            ],
            invalidation_conditions=[
                LocalizedText(
                    zh="新的快照或财报可能改变结论。",
                    en="A new snapshot or filing may change the conclusion.",
                )
            ],
            next_observations=[
                LocalizedText(
                    zh="比较下一次刷新后的证据变化。",
                    en="Compare evidence changes after the next refresh.",
                )
            ],
            confidence=0.5,
            source_refs=[f"snapshot:{snapshot_id}"],
        )
        # Re-validate through the same response contract used by real providers.
        validated = SynthesisResponse.model_validate(response.model_dump())
        return SynthesisResult(
            response=validated,
            provider=self.name,
            model=self.model,
            usage=ProviderUsage(),
            latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
            fake=True,
        )
