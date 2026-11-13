import { describe, expect, it } from "vitest";
import { alignIndices, indexHref, indexMarket } from "./market-indices-data";
import { sectorMarket } from "./sectors-data";

it("resolves China A market links without enabling an A-share sector board", () => {
  expect(indexMarket("cn")).toBe("cn");
  expect(indexHref({ scope: "cn", id: "csi-300" })).toBe("/sectors?market=cn&index=csi-300");
  expect(sectorMarket("cn")).toBeNull();
});

const point = (at: string, value: number) => ({ at, value });

describe("index comparison alignment", () => {
  it("rebases overlapping hourly slots and distinguishes gaps from other markets' hours", () => {
    const first = {
      points: [point("2026-11-04T13:30:00Z", 50), point("2026-11-04T14:30:00Z", 55), point("2026-11-04T17:30:00Z", 66)],
      gaps: ["2026-11-04T15:30:00Z"],
    };
    const second = {
      points: [point("2026-11-04T14:00:00Z", 200), point("2026-11-04T15:00:00Z", 220), point("2026-11-04T16:00:00Z", 230)],
      gaps: [],
    };
    expect(alignIndices(first, second, "1M")).toEqual([
      { at: "2026-11-04T14:00:00.000Z", left: 100, right: 100 },
      { at: "2026-11-04T15:00:00.000Z", left: null, right: 110 },
      { at: "2026-11-04T16:00:00.000Z", left: undefined, right: 115 },
      { at: "2026-11-04T17:00:00.000Z", left: 120, right: undefined },
    ]);
  });

  it("rebases weekly bars whose provider periods end on different weekdays", () => {
    const first = {
      points: [point("2026-10-28T00:00:00Z", 95), point("2026-11-04T00:00:00Z", 100), point("2026-11-11T00:00:00Z", 104)],
      gaps: [],
    };
    const second = {
      points: [point("2026-11-08T00:00:00Z", 200), point("2026-11-15T00:00:00Z", 202)],
      gaps: [],
    };
    expect(alignIndices(first, second, "MAX")).toEqual([
      { at: "2026-11-08T00:00:00.000Z", left: 100, right: 100 },
      { at: "2026-11-15T00:00:00.000Z", left: 104, right: 101 },
    ]);
  });
});
