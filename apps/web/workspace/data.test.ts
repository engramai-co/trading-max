import { describe, expect, it } from "vitest";
import { compact, compactTick, currency, percent, safeUrl } from "@/workspace/data";
import { chartNumber } from "@/workspace/research-chart-format";
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

describe("research figures in the reader's units", () => {
  it("counts Chinese figures in 万, 亿 and 万亿 to four significant digits", () => {
    expect(compact(3_800_000_000, "zh")).toBe("38亿");
    expect(compact(518_300_000, "zh")).toBe("5.183亿");
    expect(compact(12_000, "zh")).toBe("1.2万");
    expect(compact(3_812_345_678, "zh")).toBe("38.12亿");
    expect(compact(-3_812_345_678, "zh")).toBe("-38.12亿");
    expect(compact(1_234_567, "zh")).toBe("123.5万");
    expect(compact(1.2e12, "zh")).toBe("1.2万亿");
    expect(compact(999, "zh")).toBe("999");
    expect(compact(0, "zh")).toBe("0");
    for (const missing of [null, undefined, "", "N/A", NaN, {}])
      expect(compact(missing, "zh")).toBe("—");
  });
  it("keeps English figures exactly as before", () => {
    // The previous formatter, verbatim; ICU builds differ in "bn" versus "B".
    const before = (v: number) =>
      v.toLocaleString("en-GB", { notation: "compact", maximumFractionDigits: 1 });
    for (const v of [0, 999, 1234.5, 12_000, 518_300_000, 3_812_345_678, -42_500, 1.2e12]) {
      expect(compact(v, "en")).toBe(before(v));
      expect(compact(v)).toBe(before(v));
      expect(compactTick(v, "en")).toBe(before(v));
    }
  });
  it("keeps close Chinese axis ticks distinct where four digits would merge them", () => {
    const sequences = [
      [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000],
      [121_000_000, 121_050_000, 121_100_000, 121_150_000],
      [55_000, 55_025, 55_050, 55_075],
      [1234, 1234.25, 1234.5, 1234.75],
      [-0.002, -0.001, 0, 0.001, 0.002],
    ];
    for (const ticks of sequences)
      expect(new Set(ticks.map((v) => compactTick(v, "zh"))).size).toBe(ticks.length);
    expect([121_000_000, 121_050_000, 121_100_000].map((v) => compactTick(v, "zh")))
      .toEqual(["1.21亿", "1.2105亿", "1.211亿"]);
    expect([0, 50_000_000, 100_000_000, 150_000_000].map((v) => compactTick(v, "zh")))
      .toEqual(["0", "5000万", "1亿", "1.5亿"]);
    expect([1234, 1234.25].map((v) => compactTick(v, "zh"))).toEqual(["1234", "1234.25"]);
    expect(compact(121_050_000, "zh")).toBe(compact(121_100_000, "zh"));
  });
  it("formats research tooltips in the reader's units", () => {
    expect(chartNumber(3_812_345_678, "zh")).toBe("38.12亿");
    expect(chartNumber(1234.567, "zh")).toBe("1,234.57");
    expect(chartNumber(3_812_345_678)).toBe(compact(3_812_345_678, "en"));
    expect(chartNumber(null, "zh")).toBe("—");
  });
});
