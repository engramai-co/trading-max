import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { extractWorkSteps, stepStatusLabel, toolStepLabel } from "./work-steps";

describe("visible work step mapping", () => {
  it("maps known tool calls to short Chinese/English labels without leaking payloads", () => {
    expect(toolStepLabel("portfolio_overview", "zh")).toBe("读取账户记录");
    expect(toolStepLabel("portfolio_overview", "en")).toBe("Read account records");
    expect(toolStepLabel("period_performance", "zh")).toBe("核对区间收益");
    expect(toolStepLabel("period_performance", "en")).toBe("Check period performance");
    expect(toolStepLabel("unknown_internal_provider_tool", "zh")).toBe("读取工作区数据");
    expect(toolStepLabel("unknown_internal_provider_tool", "en")).toBe("Read workspace data");
  });

  it("tracks running, complete, and unavailable states while streaming and after completion", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "c1",
          toolName: "portfolio_overview",
          state: "output-available",
          input: { args: { scope: "isa" } },
          output: { status: "ok", evidence_id: "ev_1", data: { total_value_gbp: 999 } },
        },
        {
          type: "dynamic-tool",
          toolCallId: "c2",
          toolName: "period_performance",
          state: "input-available",
          input: { args: { range: "3M" } },
        },
        {
          type: "dynamic-tool",
          toolCallId: "c3",
          toolName: "compare_benchmarks",
          state: "output-available",
          input: {},
          output: { status: "unavailable", evidence_id: "ev_3" },
        },
        {
          type: "dynamic-tool",
          toolCallId: "c4",
          toolName: "data_freshness",
          state: "output-error",
          input: {},
          errorText: "secret internal traceback",
        },
      ],
    };

    const liveZh = extractWorkSteps(message, true, "zh");
    expect(liveZh).toEqual([
      { id: "c1", label: "读取账户记录", status: "complete" },
      { id: "c2", label: "核对区间收益", status: "running" },
      { id: "c3", label: "对比基准回报", status: "unavailable" },
      { id: "c4", label: "检查数据状态", status: "unavailable" },
    ]);
    const serialized = JSON.stringify(liveZh);
    expect(serialized).not.toContain("portfolio_overview");
    expect(serialized).not.toContain("secret internal traceback");
    expect(serialized).not.toContain("999");

    // Once the stream stops or ends, unfinished calls settle as unavailable rather than stuck running.
    const settledEn = extractWorkSteps(message, false, "en");
    expect(settledEn[1]).toEqual({
      id: "c2",
      label: "Check period performance",
      status: "unavailable",
    });
    expect(stepStatusLabel("running", "zh")).toBe("进行中");
    expect(stepStatusLabel("complete", "en")).toBe("Complete");
    expect(stepStatusLabel("unavailable", "zh")).toBe("暂不可用");
  });
});
