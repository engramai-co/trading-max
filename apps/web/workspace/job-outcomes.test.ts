import { describe, expect, it } from "vitest";
import { causeArea, causeKind, outcomeSummary, recovery } from "./job-outcomes";

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

  it("names a known cause and stays silent otherwise", () => {
    expect(causeKind("network", t)).toBe("Connection failed");
    expect(causeKind("rate_limit", t)).toBe("Rate limited");
    expect(causeKind("reconciliation", t)).toBe("Positions differ from summary");
    expect(causeKind(null, t)).toBeNull();
  });

  it("says how many updates succeeded after a failure, and when the latest did", () => {
    const now = new Date("2026-11-04T16:00:00Z");
    const cause = {
      errorCode: "account.snapshot_invalid",
      scope: "performance" as const,
      kind: "reconciliation" as const,
      count: 6,
      lastAt: "2026-11-02T14:30:12Z",
      succeededAfter: 1234,
      lastSuccessAt: "2026-11-04T15:30:09Z",
    };
    expect(recovery(cause, "zh", "Europe/London", now)).toBe("之后已成功 1,234 次 · 今天 15:30");
    expect(recovery(cause, "en", "Europe/London", now)).toBe("1,234 successful since · Today 15:30");
    // Still failing, or a service that does not report recoveries: nothing to say.
    expect(recovery({ ...cause, succeededAfter: 0, lastSuccessAt: null }, "zh", "Europe/London", now)).toBeNull();
    expect(recovery({ ...cause, succeededAfter: undefined as unknown as number }, "zh", "Europe/London", now)).toBeNull();
  });
});

