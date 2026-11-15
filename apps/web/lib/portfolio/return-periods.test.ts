import { expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { returnPeriods } from "./return-periods";

const row = (date: string, totalTwr: number | null) => ({ date, totalTwr } as NavPoint);

it("uses the earlier month end as the TWR starting value, excludes partial months and compounds completed gains and losses", () => {
  const grid = returnPeriods([
    row("2025-12-31", 0),
    row("2026-01-30", 0.2),
    row("2026-02-27", 0.08),
    row("2026-03-12", 0.134),
  ], "total", "2026-03-12");
  expect(grid.months[1]).toEqual({ key: "2026-01", start: "2025-12-31", end: "2026-01-30", value: 0.19999999999999996, partial: false });
  expect(grid.months[3].partial).toBe(true);
  expect(grid.quarters.find((entry) => entry.key === "2026-Q1")?.value).toBeCloseTo(0.08);
  expect(grid.annual[0]).toMatchObject({ start: "2025-12-31", end: "2026-02-27", partial: true });
});

it("does not compound across a missing or invalid month", () => {
  const grid = returnPeriods([
    row("2025-12-31", 0), row("2026-01-30", 0.03), row("2026-02-27", null),
    row("2026-03-31", 0.07), row("2026-04-30", 0.08), row("2026-05-29", 0.1),
  ], "total", "2026-06-02");
  expect(grid.annual[0].value).toBeNull();
});
