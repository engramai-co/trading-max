import { describe, expect, it } from "vitest";
import { currency, percent, safeUrl } from "@/workspace/data";
import { difference, inRange, periodReturn } from "@/lib/portfolio/nav";
import { numeric } from "@/lib/numeric";

describe("financial presentation boundaries", () => {
  it("keeps absent, nonnumeric and non-scalar amounts out of financial totals", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      false,
      [],
      {},
      NaN,
      Infinity,
      "N/A",
    ]) {
      expect(numeric(value)).toBeNull();
      expect(currency(value)).toBe("—");
    }
    expect(numeric(0)).toBe(0);
    expect(numeric("-1.25")).toBe(-1.25);
    expect(percent(0)).toBe("0.0%");
    expect(currency(-0)).toBe("£0");
    expect(currency(-0.001, "GBP", 2)).toBe("£0.00");
    expect(percent(-0.00001, true)).toBe("0.0%");
  });
  it("rebases compounded return instead of subtracting cumulative percentages", () => {
    expect(periodReturn(0.2, 0.32)).toBeCloseTo(0.1);
    expect(periodReturn(0.2, 0.08)).toBeCloseTo(-0.1);
    expect(periodReturn(null, 0.2)).toBeNull();
    expect(periodReturn(-1, 0.2)).toBeNull();
    expect(difference(null, 10)).toBeNull();
    expect(difference(100, 80)).toBe(-20);
  });
  it("uses only the latest recorded calendar day for intraday history", () => {
    const points = [
      { date: "2026-09-04T16:00:00Z" },
      { date: "2026-09-05T10:00:00Z" },
      { date: "invalid" },
      { date: "2026-09-05T09:00:00Z" },
    ];
    expect(inRange(points, "1D").map((p) => p.date)).toEqual([
      "2026-09-05T09:00:00Z",
      "2026-09-05T10:00:00Z",
    ]);
    expect(points[0].date).toBe("2026-09-04T16:00:00Z");
    expect(inRange([], "1D")).toEqual([]);
  });
  it("anchors history ranges to the last observation, including stale snapshots", () => {
    expect(
      inRange(
        [
          { date: "2024-01-01" },
          { date: "2024-02-01" },
          { date: "2024-02-15" },
        ],
        "1M",
      ),
    ).toEqual([{ date: "2024-02-01" }, { date: "2024-02-15" }]);
  });
  it("only links external research sources with web protocols", () => {
    expect(safeUrl("https://example.com/report")).toBe(
      "https://example.com/report",
    );
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///tmp/report",
      "not a URL",
    ])
      expect(safeUrl(url)).toBeUndefined();
  });
});
