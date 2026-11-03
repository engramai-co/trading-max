import { describe, expect, it } from "vitest";
import { causeArea, outcomeSummary } from "./job-outcomes";

const t = (_zh: string, en: string) => en;

describe("job outcomes", () => {
  it("counts failures and interruptions against finished updates, not cancellations", () => {
    const summary = outcomeSummary({
      since: "2026-10-27T00:00:00Z",
      totals: { succeeded: 990, failed: 8, interrupted: 2, cancelled: 5 },
    });
    expect(summary).toEqual({ finished: 1000, failures: 10, rate: 0.01 });
  });

  it("names the part of the service behind a stage error code", () => {
    expect(causeArea("broker.intraday_snapshot_failed", t)).toBe("Broker sync");
    expect(causeArea("account.nav_invalid", t)).toBe("Account calculations");
    expect(causeArea("market.snapshot_failed", t)).toBe("Research data");
    expect(causeArea("job.interrupted", t)).toBe("Interrupted");
    expect(causeArea("custom.code", t)).toBe("custom.code");
    expect(causeArea(null, t)).toBe("Unknown cause");
  });
});

