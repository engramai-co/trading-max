import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { RoleCard } from "./context";
import {
  extractTurnContext,
  formatTurnContext,
  resolveTurnTarget,
} from "./turn-context";

const NOW = Date.UTC(2026, 10, 20, 12);

describe("per-turn assistant context resolution and formatting", () => {
  it("uses the bound handoff scope and period instead of the page scope", () => {
    const dailyBrief: RoleCard = {
      role: "daily",
      title: "日报",
      object: "全部投资账户",
      context: { benchmark: "VOO" },
      origin: { page: "overview", search: "range=1D", snapshotId: "pub-daily" },
      questions: ["Q1"],
    };
    const resolved = resolveTurnTarget(dailyBrief, "overview", "scope=isa&range=1M", "Europe/London");
    expect(resolved.requestContext).toMatchObject({
      page: "overview",
      role: "daily",
      scope: "broker_total",
      range: "1D",
      snapshotId: "pub-daily",
      object: { benchmark: "VOO" },
    });
    expect(resolved.turnContext).toMatchObject({
      page: "overview",
      role: "daily",
      scope: "broker_total",
      range: "1D",
      snapshotId: "pub-daily",
    });
    expect(formatTurnContext(resolved.turnContext, "zh", "Europe/London", NOW)).toBe(
      "日报 · 全部投资账户 · 1D",
    );
    expect(formatTurnContext(resolved.turnContext, "en", "Europe/London", NOW)).toBe(
      "Daily brief · All investment accounts · 1D",
    );
  });

  it("resolves and formats page scope, range, research lens, ticker, and selected date windows", () => {
    const analytics = resolveTurnTarget(null, "analytics", "scope=invest&range=1D&benchmark=VOO", "Europe/London",
      { page: "analytics", scope: "isa", range: "3M", benchmark: "QQQ" });
    expect(formatTurnContext(analytics.turnContext, "zh", "Europe/London", NOW)).toBe(
      "收益与风险 · ISA · 3M · QQQ",
    );
    expect(formatTurnContext(analytics.turnContext, "en", "Europe/London", NOW)).toBe(
      "Performance · ISA · 3M · QQQ",
    );

    const research = resolveTurnTarget(
      null,
      "research",
      "ticker=STALE&view=technical",
      "Europe/London",
      { page: "research", ticker: "NVDA", lens: "valuation", range: "6M" },
    );
    expect(formatTurnContext(research.turnContext, "zh", "Europe/London", NOW)).toBe("NVDA · 估值 · 6M");
    expect(formatTurnContext(research.turnContext, "en", "Europe/London", NOW)).toBe("NVDA · Valuation · 6M");

    const attribution: RoleCard = {
      role: "attribution",
      title: "归因",
      object: "2026-01-06 – 2026-01-20",
      context: {
        scope: "isa",
        range: "1M",
        view: "returns",
        benchmark: "VOO",
        start: "2026-01-06",
        end: "2026-01-20",
      },
      origin: {
        page: "analytics",
        search: "scope=isa&range=1M&benchmark=VOO",
        snapshotId: "pub-2",
      },
      questions: [],
    };
    const brushed = resolveTurnTarget(attribution, "holdings", "", "Europe/London");
    expect(formatTurnContext(brushed.turnContext, "zh", "Europe/London", NOW)).toBe(
      "归因 · ISA · 1月6日 – 1月20日 · VOO",
    );
    expect(formatTurnContext(brushed.turnContext, "en", "Europe/London", NOW)).toBe(
      "Attribution · ISA · 6 Jan – 20 Jan · VOO",
    );
  });

  it("uses the displayed Analytics window and Research range independently of URL defaults", () => {
    const analytics = resolveTurnTarget(null, "analytics", "range=1D", "Europe/London", {
      page: "analytics", scope: "isa", range: "ALL", start: "2026-01-06", end: "2026-01-20", benchmark: "QQQ",
    });
    expect(analytics.requestContext).toMatchObject({ start: "2026-01-06", end: "2026-01-20", benchmark: "QQQ" });
    expect(formatTurnContext(analytics.turnContext, "en", "Europe/London", NOW))
      .toBe("Performance · ISA · 6 Jan – 20 Jan · QQQ");
    for (const range of ["3M", "5D"]) {
      const turn = resolveTurnTarget(null, "research", "", "Europe/London", { page: "research", ticker: "NVDA", lens: "technical", range });
      expect(turn.requestContext).toMatchObject({ page: "research", lens: "technical", ticker: "NVDA", range });
      expect(formatTurnContext(turn.turnContext, "en", "Europe/London", NOW)).toBe(`NVDA · Price · ${range}`);
    }
  });

  it("extracts valid turnContext from UIMessage metadata and returns null for older turns", () => {
    const legacy: UIMessage = {
      id: "old",
      role: "user",
      parts: [{ type: "text", text: "Older question" }],
    };
    expect(extractTurnContext(legacy)).toBeNull();

    const emptyMeta: UIMessage = {
      id: "empty",
      role: "user",
      metadata: { pydantic_ai: { timestamp: "2026-11-20T12:00:00Z" } },
      parts: [{ type: "text", text: "Older stored turn" }],
    };
    expect(extractTurnContext(emptyMeta)).toBeNull();

    const stored: UIMessage = {
      id: "new",
      role: "user",
      metadata: {
        turnContext: {
          page: "analytics",
          scope: "isa",
          range: "3M",
          snapshotId: "pub-9",
          ignoredField: "drop-me",
        },
      },
      parts: [{ type: "text", text: "What moved?" }],
    };
    expect(extractTurnContext(stored)).toEqual({
      page: "analytics",
      scope: "isa",
      range: "3M",
      snapshotId: "pub-9",
    });
  });

  it("uses the same localized selection label in the composer and History", () => {
    const exposure: RoleCard = {
      role: "exposure",
      title: "敞口",
      object: "美国",
      context: { dimension: "country", category: "United States" },
      origin: { page: "holdings", search: "", snapshotId: "pub-3" },
      questions: [],
    };
    const resolved = resolveTurnTarget(exposure, "holdings", "", "Europe/London");
    const stored = extractTurnContext({
      id: "exposure",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
      metadata: { turnContext: resolved.requestContext },
    });
    for (const context of [resolved.turnContext, stored!]) {
      expect(formatTurnContext(context, "zh", "Europe/London", NOW)).toBe("敞口 · 美国 · 全部投资账户");
      expect(formatTurnContext(context, "en", "Europe/London", NOW)).toBe("Exposure · United States · All investment accounts");
    }
  });
});
