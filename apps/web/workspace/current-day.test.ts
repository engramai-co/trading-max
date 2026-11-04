import { describe, expect, it } from "vitest";
import { calendarDay, untilNextDay } from "./current-day";

const at = (iso: string) => Date.parse(iso);

describe("current day", () => {
  it("reads the calendar day in the display time zone", () => {
    // 16:30 UTC on Friday is already Saturday in Shanghai.
    expect(calendarDay(at("2026-11-06T16:30:00Z"), "Europe/London")).toBe("2026-11-06");
    expect(calendarDay(at("2026-11-06T16:30:00Z"), "Asia/Shanghai")).toBe("2026-11-07");
    // 23:30 UTC in summer is 00:30 the next day in London.
    expect(calendarDay(at("2026-07-03T23:30:00Z"), "Europe/London")).toBe("2026-07-04");
  });

  it("wakes at most a second after the next midnight", () => {
    const within = (now: string, zone: string, midnight: string) => {
      const delay = untilNextDay(at(now), zone);
      expect(delay).toBeGreaterThan(at(midnight) - at(now));
      expect(delay).toBeLessThanOrEqual(at(midnight) - at(now) + 1_000);
    };
    // Friday 23:59:30 in London; Saturday begins 30 seconds later.
    within("2026-11-06T23:59:30Z", "Europe/London", "2026-11-07T00:00:00Z");
    within("2026-07-03T22:59:00Z", "Europe/London", "2026-07-03T23:00:00Z");
    within("2026-11-06T15:59:00Z", "Asia/Shanghai", "2026-11-06T16:00:00Z");
    // Clocks go forward at 01:00 that day, so the next midnight is 22.5 hours away.
    within("2026-03-29T00:30:00Z", "Europe/London", "2026-03-29T23:00:00Z");
    within("2026-10-25T00:30:00Z", "Europe/London", "2026-10-26T00:00:00Z");
  });
});
