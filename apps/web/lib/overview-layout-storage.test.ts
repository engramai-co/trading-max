import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { overviewLayoutInitScript, parseOverviewLayout } from "./overview-layout-storage";

const layout = {
  rows: { stocks: 18, funds: 2 },
  ledger: 1048.59375,
  reading: { range: "1D", summary: 316.5, history: 406, plotTop: 96 },
};

function runBootstrap(raw: string) {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const parse = vi.fn(JSON.parse);
  const removeItem = vi.fn();
  const setItem = vi.fn();
  runInNewContext(overviewLayoutInitScript("a".repeat(64)), {
    JSON: { parse, stringify: JSON.stringify },
    location: { pathname: "/", search: "" },
    navigator: { onLine: true },
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    sessionStorage: { getItem: () => raw, removeItem, setItem },
    localStorage: { getItem: () => "en" },
    document: { documentElement: {
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
    } },
  });
  return { attributes, properties, parse, removeItem, setItem };
}

describe("Overview layout bootstrap", () => {
  it("uses valid counts and subpixel geometry", () => {
    const raw = JSON.stringify(layout);
    expect(parseOverviewLayout(raw)).toEqual(layout);
    const { attributes, properties, removeItem } = runBootstrap(raw);
    expect(attributes.get("data-mx-boot-ledger")).toBe("rows");
    expect(attributes.get("data-mx-boot-history")).toBe("plot");
    expect(properties.get("--mx-boot-ledger-rows")).toBe("20");
    expect(properties.get("--mx-boot-ledger-height")).toBe("1048.59375px");
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("discards an oversized string before parsing its otherwise valid geometry", () => {
    const raw = JSON.stringify({
      ...layout, padding: "x".repeat(128 * 1024),
    });
    expect(parseOverviewLayout(raw)).toBeUndefined();
    const { attributes, properties, parse, removeItem } = runBootstrap(raw);
    expect(parse).not.toHaveBeenCalled();
    expect(attributes.size).toBe(0);
    expect(properties.size).toBe(0);
    expect(removeItem).toHaveBeenCalledOnce();
  });

  it.each([21_113.5, 35_138.5])("keeps the measured height of a 240-row ledger at %s px", ledger => {
    const tall = { ...layout, rows: { stocks: 238, funds: 2 }, ledger };
    const raw = JSON.stringify(tall);
    expect(parseOverviewLayout(raw)).toEqual(tall);
    expect(runBootstrap(raw).properties.get("--mx-boot-ledger-height")).toBe(ledger + "px");
  });

  it.each([
    ["per-row allowance exceeded", { ...layout, ledger: 10_001 }],
    ["absolute ceiling exceeded", { ...layout, rows: { stocks: 498, funds: 2 }, ledger: 200_001 }],
    ["huge ledger", { ...layout, ledger: 500_000 }],
  ])("keeps rows and chart geometry for %s", (_, entry) => {
    const raw = JSON.stringify(entry);
    const fallback = { rows: entry.rows, reading: entry.reading };
    expect(parseOverviewLayout(raw)).toEqual(fallback);
    const { attributes, properties, removeItem, setItem } = runBootstrap(raw);
    expect(attributes.get("data-mx-boot-ledger")).toBe("rows");
    expect(properties.get("--mx-boot-ledger-rows")).toBe(String(entry.rows.stocks + entry.rows.funds));
    expect(properties.has("--mx-boot-ledger-height")).toBe(false);
    expect(attributes.has("data-mx-boot-ledger-measured")).toBe(false);
    expect(attributes.get("data-mx-boot-history")).toBe("plot");
    expect(removeItem).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledWith(expect.any(String), JSON.stringify(fallback));
  });

  it.each([
    { ...layout.reading, summary: 500_000 },
    { ...layout.reading, history: 500_000 },
    { ...layout.reading, plotTop: 500_000 },
    { ...layout.reading, range: "5D" },
    null,
  ])("keeps valid ledger geometry when the chart entry is invalid (%j)", reading => {
    const { rows, ledger } = layout;
    const raw = JSON.stringify({ rows, ledger, reading });
    expect(parseOverviewLayout(raw)).toEqual({ rows, ledger });
    const { attributes, properties, setItem } = runBootstrap(raw);
    expect(attributes.has("data-mx-boot-history")).toBe(false);
    expect(properties.get("--mx-boot-ledger-height")).toBe(ledger + "px");
    expect(setItem).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ rows, ledger }));
  });

  it("keeps a counts-only entry across later reads", () => {
    const fallback = { rows: layout.rows };
    const raw = JSON.stringify(fallback);
    expect(parseOverviewLayout(raw)).toEqual(fallback);
    const { properties, removeItem, setItem } = runBootstrap(raw);
    expect(properties.get("--mx-boot-ledger-rows")).toBe("20");
    expect(properties.has("--mx-boot-ledger-height")).toBe(false);
    expect(removeItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps date-badged counts when the measured height fails", () => {
    const rows = { stocks: 238, funds: 2, dateTagged: 24 };
    const raw = JSON.stringify({ ...layout, rows, ledger: 500_000 });
    expect(raw.length).toBeLessThan(512);
    expect(parseOverviewLayout(raw)).toEqual({ rows, reading: layout.reading });
  });

  it.each([-1, 2.5, 21])("ignores an invalid date-badged count of %s", dateTagged => {
    const raw = JSON.stringify({ ...layout, rows: { ...layout.rows, dateTagged } });
    expect(parseOverviewLayout(raw)).toEqual(layout);
  });

  it.each([
    ["too many rows", { ...layout, rows: { stocks: 500, funds: 1 } }],
    ["negative rows", { ...layout, rows: { stocks: -1, funds: 2 } }],
    ["NaN rows", { ...layout, rows: { stocks: NaN, funds: 2 } }],
    ["fractional rows", { ...layout, rows: { stocks: 1.5, funds: 2 } }],
  ])("discards the whole entry for %s", (_, entry) => {
    const raw = JSON.stringify(entry);
    expect(parseOverviewLayout(raw)).toBeUndefined();
    const { attributes, properties, removeItem } = runBootstrap(raw);
    expect(attributes.size).toBe(0);
    expect(properties.size).toBe(0);
    expect(removeItem).toHaveBeenCalledOnce();
  });
});
