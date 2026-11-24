import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { verifiedInterruptedLines, verifiedLines } from "./chat-reply";
import {
  INITIAL_TURN_STORE,
  beginTurnAttempt,
  failureCode,
  pairConversationTurns,
  settleTurnAttempt,
  shouldRestoreDraftOnStop,
  stopTurnAttempt,
  turnAnnouncementText,
  turnStatusText,
} from "./turn-state";

const zh = (z: string) => z;
const en = (_z: string, e: string) => e;

const partialVerifiedAssistant: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolCallId: "p1",
      toolName: "period_performance",
      state: "output-available",
      input: {},
      output: {
        evidence_id: "ev_period",
        status: "ok",
        scope: "isa",
        data: { period_pnl_gbp: 21.5, window_start: "2026-11-12", window_end: "2026-11-13" },
      },
    },
    {
      type: "text",
      text: "{{/data/period_pnl_gbp}} [ev_period]\n{{cash-flows}} [inference]",
    },
  ],
};

describe("recoverable interruption and per-turn terminal state", () => {
  it("marks Stop terminally, freezes verified content, and ignores late stream events", () => {
    const started = beginTurnAttempt(INITIAL_TURN_STORE, {
      userMessageId: "u1",
      attemptId: 1,
      prompt: "How did ISA do?",
      requestContext: { page: "analytics", scope: "isa", range: "3M" },
      turnContext: { page: "analytics", scope: "isa", range: "3M" },
      card: null,
    });

    const stopped = stopTurnAttempt(started, 1, partialVerifiedAssistant);
    expect(stopped.store.active).toBeNull();
    expect(stopped.store.turns.u1.status).toBe("stopped");
    expect(stopped.store.turns.u1.frozenAssistant?.parts).toHaveLength(2);
    expect(stopped.announcement).toEqual({ kind: "stopped" });
    expect(turnAnnouncementText(stopped.announcement!, "en", "Europe/London", en)).toBe(
      "Generation stopped.",
    );
    expect(turnStatusText("stopped", undefined, true, zh)).toBe("已停止 · 仅保留已核实内容");

    // Late stream completion or error for the stopped attempt is ignored and announces nothing.
    const lateFinish = settleTurnAttempt(stopped.store, {
      attemptId: 1,
      assistantMessage: {
        ...partialVerifiedAssistant,
        parts: [...partialVerifiedAssistant.parts, { type: "text", text: "late extra text" }],
      },
      isAbort: false,
      isDisconnect: false,
      isError: false,
      sawFinish: true,
      sawAbort: false,
      finishReason: "stop",
    });
    expect(lateFinish.store).toBe(stopped.store);
    expect(lateFinish.announcement).toBeNull();
    expect(lateFinish.store.turns.u1.frozenAssistant?.parts).toHaveLength(2);

    // Duplicate Stop also produces no second announcement.
    const secondStop = stopTurnAttempt(stopped.store, 1, partialVerifiedAssistant);
    expect(secondStop.announcement).toBeNull();
  });

  it("keeps one independently verified line when the remaining reply is incomplete", () => {
    const reply: UIMessage = {
      ...partialVerifiedAssistant,
      parts: [
        partialVerifiedAssistant.parts[0],
        { type: "text", text: "{{/data/period_pnl_gbp}} [ev_period]\n{{incomplete" },
      ],
    };
    expect(verifiedLines(reply)).toEqual([]);
    const lines = verifiedInterruptedLines(reply, "en", "Europe/London");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("Period net P&L £21.50");
  });

  it("never restores over a draft typed during streaming", () => {
    expect(shouldRestoreDraftOnStop("")).toBe(true);
    expect(shouldRestoreDraftOnStop("Follow-up question")).toBe(false);
    expect(shouldRestoreDraftOnStop(" ")).toBe(false);
    expect(shouldRestoreDraftOnStop("", true)).toBe(false);
  });

  it("requires explicit stream finish to publish completed state and classifies failures", () => {
    const started = beginTurnAttempt(INITIAL_TURN_STORE, {
      userMessageId: "u1",
      attemptId: 1,
      prompt: "Check ISA",
      requestContext: { page: "analytics", scope: "isa", range: "3M" },
      turnContext: { page: "analytics", scope: "isa", range: "3M" },
      card: null,
    });

    // Stream closed without finish or abort -> disconnected (not completed).
    const dropped = settleTurnAttempt(started, {
      attemptId: 1,
      assistantMessage: partialVerifiedAssistant,
      isAbort: false,
      isDisconnect: false,
      isError: false,
      sawFinish: false,
      sawAbort: false,
    });
    expect(dropped.store.turns.u1.status).toBe("disconnected");
    expect(dropped.announcement).toEqual({
      kind: "failed",
      status: "disconnected",
    });

    for (const finishReason of ["error", "length", "content-filter"] as const) {
      const failed = settleTurnAttempt(started, {
        attemptId: 1,
        assistantMessage: partialVerifiedAssistant,
        isAbort: false,
        isDisconnect: false,
        isError: false,
        sawFinish: true,
        sawAbort: false,
        finishReason,
      });
      expect(failed.store.turns.u1.status).toBe("failed");
      expect(failed.store.turns.u1.frozenAssistant?.parts).toHaveLength(2);
    }
    // Rate-limited response (HTTP 429 or explicit code).
    expect(failureCode('{"detail":{"code":"provider_rate_limited"}}')).toBe("provider_rate_limited");
    expect(failureCode("Too Many Requests", 429)).toBe("provider_rate_limited");
    expect(failureCode('{"detail":{"code":"provider_not_configured"}}', 409)).toBe("provider_not_configured");
    expect(failureCode("Conflict", 409)).toBe("assistant_busy");
    const rateLimited = settleTurnAttempt(started, {
      attemptId: 1,
      assistantMessage: null,
      isAbort: false,
      isDisconnect: false,
      isError: true,
      sawFinish: false,
      sawAbort: false,
      errorCode: "provider_rate_limited",
    });
    expect(rateLimited.store.turns.u1.status).toBe("rate_limited");
    expect(turnAnnouncementText(rateLimited.announcement!, "zh", "Europe/London", zh)).toBe(
      "服务繁忙，稍后重试。",
    );

    // Explicit finish publishes completed state and announces verified reply once.
    const completed = settleTurnAttempt(started, {
      attemptId: 1,
      assistantMessage: partialVerifiedAssistant,
      isAbort: false,
      isDisconnect: false,
      isError: false,
      sawFinish: true,
      sawAbort: false,
      finishReason: "stop",
    });
    expect(completed.store.turns.u1.status).toBe("completed");
    expect(completed.announcement?.kind).toBe("completed");
    expect(turnAnnouncementText(completed.announcement!, "en", "Europe/London", en)).toContain(
      "Period net P&L £21.50",
    );
  });

  it("keeps the original publication and verified lines through a rate-limited retry", () => {
    const started = beginTurnAttempt(INITIAL_TURN_STORE, {
      userMessageId: "u1", attemptId: 1, prompt: "Check ISA",
      requestContext: { page: "analytics", scope: "isa", range: "3M" },
      turnContext: { page: "analytics", scope: "isa", range: "3M" }, card: null,
    });
    const stopped = stopTurnAttempt(started, 1, partialVerifiedAssistant, "synthetic-original").store;
    const original = stopped.turns.u1;
    expect(original.requestContext.snapshotId).toBe("synthetic-original");
    const retried = beginTurnAttempt(stopped, { ...original, attemptId: 2 });
    const failed = settleTurnAttempt(retried, {
      attemptId: 2, assistantMessage: null, isAbort: false, isDisconnect: false,
      isError: true, sawFinish: false, sawAbort: false, errorCode: "provider_rate_limited",
    });
    const result = failed.store.turns.u1;
    expect(result.status).toBe("rate_limited");
    expect(result.requestContext).toEqual(original.requestContext);
    expect(result.frozenAssistant).toEqual(partialVerifiedAssistant);
  });

  it("pairs user turns cleanly when an earlier turn stopped before any assistant chunk", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "First stopped" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Second completed" }] },
      partialVerifiedAssistant,
    ];
    const exchanges = pairConversationTurns(messages);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].user?.id).toBe("u1");
    expect(exchanges[0].assistant).toBeUndefined();
    expect(exchanges[1].user?.id).toBe("u2");
    expect(exchanges[1].assistant?.id).toBe("a1");
  });
});
