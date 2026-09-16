import { describe, expect, it } from "vitest";
import {
  expirationSummary,
  nearMoneyStrikes,
  reportedGrowth,
} from "./research-math";

describe("research evidence boundaries", () => {
  it("keeps negative-base growth meaningful and leaves zero or missing bases undefined", () => {
    expect(reportedGrowth(-5, -10)).toBe(0.5);
    expect(reportedGrowth(5, -10)).toBe(1.5);
    expect(reportedGrowth(5, 0)).toBeNull();
    expect(reportedGrowth(null, 10)).toBeNull();
  });
  it("pairs nearest unique strikes in ascending order without changing the chain", () => {
    const strikes = [120, 80, 100, 110, 90, 100];
    expect(nearMoneyStrikes(strikes, 102, 3)).toEqual([90, 100, 110]);
    expect(strikes).toEqual([120, 80, 100, 110, 90, 100]);
    expect(nearMoneyStrikes(strikes, 0)).toEqual([]);
  });
  it("changes summary with expiry and preserves unavailable expiry evidence", () => {
    const expirations = [
      { expiry: "2026-09-18", maxPain: 100 },
      { expiry: "2026-10-16", maxPain: 120 },
    ];
    expect(expirationSummary(expirations, "2026-10-16")?.maxPain).toBe(120);
    expect(expirationSummary(expirations, "2026-09-18")?.maxPain).toBe(100);
    expect(expirationSummary(expirations, "2026-12-18")).toBeUndefined();
  });
});
