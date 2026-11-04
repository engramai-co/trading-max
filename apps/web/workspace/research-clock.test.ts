import { describe, expect, it } from "vitest";
import { exchangeDate, lensDay, lensTurned } from "./research-clock";

// A New York quote whose synthetic schedule, built on 4 November 2026, lists
// sessions up to Friday 13 November and stops covering at Monday's open.
const quote = {
  timezone: "America/New_York",
  schedule: {
    sessions: [{ date: "2026-11-13", open: "2026-11-13T14:30:00Z", close: "2026-11-13T21:00:00Z" }],
    until: "2026-11-16T14:30:00Z",
  },
};
const at = (instant: string) => lensDay(quote, new Date(instant));

describe("research clock", () => {
  it("reads dates in the exchange's time zone", () => {
    expect(exchangeDate(new Date("2026-11-05T04:59:00Z"), "America/New_York")).toBe("2026-11-04");
    expect(exchangeDate(new Date("2026-11-05T05:00:00Z"), "America/New_York")).toBe("2026-11-05");
    expect(exchangeDate(new Date("2026-08-31T23:30:00Z"), "Europe/London")).toBe("2026-09-01");
    // An unknown or missing zone falls back to UTC.
    expect(exchangeDate(new Date("2026-11-05T00:30:00Z"), "Mars/Olympus")).toBe("2026-11-05");
    expect(exchangeDate(new Date("2026-11-05T00:30:00Z"), null)).toBe("2026-11-05");
  });

  it("refetches lenses at New York midnight, not at UTC midnight", () => {
    expect(lensTurned(at("2026-11-04T23:59:00Z"), at("2026-11-05T00:01:00Z"))).toBe(false);
    expect(at("2026-11-05T04:59:00Z").date).toBe("2026-11-04");
    expect(lensTurned(at("2026-11-05T04:59:00Z"), at("2026-11-05T05:00:00Z"))).toBe(true);
  });

  it("refetches lenses once when the session schedule runs out", () => {
    expect(at("2026-11-16T14:29:00Z")).toEqual({ date: "2026-11-16", expired: false });
    expect(lensTurned(at("2026-11-16T14:29:00Z"), at("2026-11-16T14:30:00Z"))).toBe(true);
    expect(lensTurned(at("2026-11-16T14:30:00Z"), at("2026-11-16T14:31:00Z"))).toBe(false);
    // Without a schedule only the date turns.
    const unknown = { timezone: "America/New_York" };
    expect(lensDay(unknown, new Date("2027-01-01T12:00:00Z")).expired).toBe(false);
  });
});
