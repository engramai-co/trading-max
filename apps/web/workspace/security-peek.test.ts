import { describe, expect, it } from "vitest";
import { latestSession } from "./security-peek";

describe("latestSession", () => {
  it("starts the latest session's path at the close before it", () => {
    const session = latestSession([
      { date: "2026-11-12T15:45:00-05:00", close: 99 },
      { date: "2026-11-12T16:00:00-05:00", close: 100 },
      { date: "2026-11-13T09:30:00-05:00", close: 101 },
      { date: "2026-11-13T09:45:00-05:00", close: null },
      { date: "2026-11-13T10:00:00-05:00", close: 98 },
    ]);
    expect(session.day).toBe("2026-11-13");
    expect(session.closes).toEqual([100, 101, 98]);
    expect(session.bars).toBe(2);
    expect(session.change).toBeCloseTo(-0.02, 10);
  });

  it("keeps exchange dates, so a late US bar is not the next London day", () => {
    const session = latestSession([
      { date: "2026-11-12T15:45:00-05:00", close: 50 },
      { date: "2026-11-13T15:45:00-05:00", close: 55 },
    ]);
    expect(session.day).toBe("2026-11-13");
    expect(session.change).toBeCloseTo(0.1, 10);
  });

  it("has no move without an earlier close, and no path from one bar", () => {
    expect(latestSession([{ date: "2026-11-13T09:30:00Z", close: 10 }])).toMatchObject({ change: null, bars: 1 });
    expect(latestSession([])).toMatchObject({ day: null, closes: [], change: null, bars: 0 });
  });
});
