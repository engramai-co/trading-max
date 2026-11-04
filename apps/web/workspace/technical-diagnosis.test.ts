import { describe, expect, it } from "vitest";
import type { TechnicalScoreSummary } from "@/lib/types";
import { factorMeaning, impactTone, isLatestSession, stateName } from "./technical-diagnosis";

const en = (_zh: string, english: string) => english;

describe("technical diagnosis presentation", () => {
  it("distinguishes absent inputs from zero contributions", () => {
    expect(impactTone(null)).toBe("");
    expect(impactTone(0)).toBe("");
    expect(factorMeaning({ key: "rsi", value: null, reference: null, contribution: null }, en)).toBe("RSI · Reading unavailable");
  });
  it("respects equality and the existing ADX / RSI rules", () => {
    expect(factorMeaning({ key: "sma50", value: 100, reference: 100, contribution: -10 }, en)).toBe("Close at or below SMA50");
    expect(factorMeaning({ key: "adx", value: 20, reference: 25, contribution: 0 }, en)).toContain("no directional points");
    expect(factorMeaning({ key: "rsi", value: 81, reference: null, contribution: -2 }, en)).toBe("RSI above 80");
  });
  it("does not turn an unscored row into a neutral or bullish diagnosis", () => {
    expect(stateName({ score: null, state: "强势趋势" } as TechnicalScoreSummary, en)).toBe("Not scored");
  });
  it("dates a score only when it is older than the last weekday session", () => {
    expect(isLatestSession("2026-11-03", "2026-11-04")).toBe(true);
    expect(isLatestSession("2026-11-02", "2026-11-04")).toBe(false);
    // Monday reads Friday's close as the latest session.
    expect(isLatestSession("2026-11-06", "2026-11-09")).toBe(true);
    expect(isLatestSession("2026-11-05", "2026-11-09")).toBe(false);
  });
});
