import { describe, expect, it } from "vitest";
import type { TechnicalScoreGroup, TechnicalScoreSummary } from "@/lib/types";
import { factorMeaning, groupState, impactTone, keyImpacts, stateName } from "./technical-diagnosis";

const en = (_zh: string, english: string) => english;
const group = (key: TechnicalScoreGroup["key"], contribution: number | null): TechnicalScoreGroup => ({ key, contribution, factors: [] });

describe("technical diagnosis presentation", () => {
  it("distinguishes absent inputs from zero contributions", () => {
    expect(groupState(group("volume", null), en)).toBe("Unavailable");
    expect(groupState(group("volume", 0), en)).toBe("Neutral / mixed");
    expect(impactTone(null)).toBe("");
    expect(impactTone(0)).toBe("");
    expect(factorMeaning({ key: "rsi", value: null, reference: null, contribution: null }, en)).toBe("RSI · Reading unavailable");
  });
  it("respects equality and the existing ADX / RSI rules", () => {
    expect(factorMeaning({ key: "sma50", value: 100, reference: 100, contribution: -10 }, en)).toBe("Close at or below SMA50");
    expect(factorMeaning({ key: "adx", value: 20, reference: 25, contribution: 0 }, en)).toContain("no directional points");
    expect(factorMeaning({ key: "rsi", value: 81, reference: null, contribution: -2 }, en)).toBe("RSI above 80");
  });
  it("shows the strongest favorable and adverse groups without inventing subscores", () => {
    const groups = [group("trend", -20), group("momentum", -4), group("relative", 9), group("volume", null)];
    const summary = { scoreBreakdown: { groups } } as TechnicalScoreSummary;
    expect(keyImpacts(summary).map((g) => g.contribution)).toEqual([-20, 9]);
    expect(keyImpacts(null)).toEqual([]);
  });
  it("does not turn an unscored row into a neutral or bullish diagnosis", () => {
    expect(stateName({ score: null, state: "强势趋势" } as TechnicalScoreSummary, en)).toBe("Not scored");
  });
});
