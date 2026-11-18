import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import outputs from "./__fixtures__/review-tools.json";
import { verifiedLines } from "./chat-reply";
import { evidenceHref } from "./evidence";
import { renderToolField } from "./figures";

describe("sidebar fields from the review tools", () => {
  const habitsTool = "review_patterns",
    decisionTool = "decision_timing_and_habits";
  const zone = "Europe/London";
  const render = (pointer: string) => renderToolField(decisionTool, outputs.decision, pointer, "en", zone);

  it("names the hindsight window, ticker, basis and fee currency from the cited result", () => {
    const gap = render("/data/items/0/hindsight/missed_gbp");
    for (const word of [
      "TEST",
      "2026-02-03",
      "In hindsight",
      "average purchase size",
      "£12.00",
      "2026-03-04",
      "20 trading days",
    ]) {
      expect(gap).toContain(word);
    }
    expect(render("/data/items/0/market_return")).toContain("Matched S&P 500 return in GBP · +3.0%");
    expect(render("/data/items/0/prior_close_gbp")).toBeNull();
    expect(render("/data/items/2/security_return")).toBeNull();
  });

  it.each([outputs.decision.bound_arguments, {}])("reopens the published decision with or without role bindings", (bound) => {
    const [line] = verifiedLines({
      id: "answer", role: "assistant", parts: [
        { type: "dynamic-tool", toolName: decisionTool, toolCallId: "d", state: "output-available",
          input: {}, output: { ...outputs.decision, bound_arguments: bound } },
        { type: "text", text: "{{/data/items/0/hindsight/missed_gbp}} [ev_decision]\n{{history}} [inference]" },
      ],
    });
    const opened = new URL(evidenceHref(line.evidence!)!, "https://example.org");
    expect(opened.pathname).toBe("/review");
    expect(Object.fromEntries(opened.searchParams)).toMatchObject({
      account: "A", decision: "2026-02-03.buy.TEST", reviewOrdinal: "0", reviewWindow: "20_sessions", snapshotId: "synthetic",
    });
  });

  it("binds the no-trade sign, coverage and window to the selected group", () => {
    const pointer = "/data/groups/untraded_fall/effect_gbp";
    const output = { ...outputs.habits, status: "partial" };
    const text = renderToolField(habitsTool, output, pointer, "en", zone);
    for (const word of [
      "Large falls without a trade",
      "net hypothetical loss",
      "£7.00",
      "average purchase",
      "1/1 measured",
      "To date",
      "2026-03-06",
      "Limited coverage",
    ]) {
      expect(text).toContain(word);
    }
    expect(renderToolField(habitsTool, output, pointer, "zh", zone)).toContain("事后看，假设加仓的净亏损约 £7.00");
    expect(renderToolField(habitsTool, output, "/data/groups/basket_buy/mean_return", "en", zone)).toContain(
      "+4.5%",
    );
    expect(renderToolField(habitsTool, output, "/data/groups/untraded_fall/mean_return", "en", zone)).toBeNull();
  });

  it("renders a complete cited turn and withholds a substituted number or habit", () => {
    const reply = (first: string): UIMessage => ({
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: habitsTool,
          toolCallId: "h",
          state: "output-available",
          input: { args: { scope: "invest" } },
          output: outputs.habits,
        },
        { type: "text", text: first + " [ev_habits]\n{{history}} [inference]" },
      ],
    });
    const pointer = "{{/data/groups/basket_buy/effect_gbp}}";
    const fact = verifiedLines(reply(pointer))[0];
    expect(fact.text).toContain("£9.00");
    expect(fact.evidence?.arguments).toMatchObject({ scope: "invest", horizon: "to_date", habitSection: "basket_buy" });
    const opened = new URL(evidenceHref(fact.evidence!)!, "https://example.org");
    expect(opened.searchParams.get("habit")).toBe("basket_buy");
    expect(opened.searchParams.get("reviewWindow")).toBe("to_date");
    expect(verifiedLines(reply("£300 " + pointer))).toEqual([]);
    expect(verifiedLines(reply("{{/data/groups/unknown/effect_gbp}}"))).toEqual([]);
  });
});

it("reopens the compared habit horizon from its published figure", () => {
  const data = outputs.habits.data;
  const [line] = verifiedLines({id:"compare",role:"assistant",parts:[
    {type:"dynamic-tool",toolName:"review_patterns",toolCallId:"h",state:"output-available",input:{compare_horizons:true},
      output:{...outputs.habits,data:{...data,comparison:{horizon:"20_sessions",groups:data.groups}}}},
    {type:"text",text:"{{/data/comparison/groups/untraded_fall/effect_gbp}} [ev_habits]\n{{history}} [inference]"},
  ]});
  expect(line?.text).toMatch(/20 trading days/i);
  expect(evidenceHref(line.evidence!)).toContain("reviewWindow=20_sessions");
});
