import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  OVERVIEW_LAYOUT_ACTIVE_KEY, OVERVIEW_LAYOUT_GENERATION_SUFFIX, OVERVIEW_LAYOUT_VERSION_PREFIX,
  overviewLayoutInitScript, parseOverviewLayout,
} from "./overview-layout-storage";

const layout = {
  rows: { stocks: 18, funds: 2 },
  ledger: 1048.59375,
  reading: { range: "1D", summary: 316.5, history: 406, plotTop: 96 },
};

const prefix = OVERVIEW_LAYOUT_VERSION_PREFIX + "a".repeat(64) + ":";
const key = prefix + "total:en:desktop";

function testStorage(entries: Record<string, string>) {
  return Object.assign(Object.create({
    getItem: vi.fn((key: string) => entries[key] ?? null),
    removeItem: vi.fn(function(this: Record<string, string>, key: string) { delete entries[key]; delete this[key]; }),
    setItem: vi.fn(function(this: Record<string, string>, key: string, value: string) { entries[key] = value; this[key] = value; }),
  }), entries) as Storage;
}

function runBootstrap(raw?: string, legacy: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const parse = vi.fn(JSON.parse);
  const session = testStorage(legacy);
  const persisted = testStorage({ "trading_max-locale": "en", [OVERVIEW_LAYOUT_ACTIVE_KEY]: prefix, ...extra,
    ...(raw === undefined ? {} : { [key]: raw }) });
  runInNewContext(overviewLayoutInitScript("a".repeat(64)), {
    JSON: { parse, stringify: JSON.stringify },
    location: { pathname: "/", search: "" },
    navigator: { onLine: true },
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    sessionStorage: session,
    localStorage: persisted,
    document: { documentElement: {
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
    } },
  });
  return { attributes, properties, parse, removeItem: persisted.removeItem, setItem: persisted.setItem, session, persisted };
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

  it("shares the measured period figure with pre-paint and keeps older reservations usable", () => {
    const measured = { ...layout, reading: { ...layout.reading, periodFigure: 40 } };
    expect(parseOverviewLayout(JSON.stringify(measured))).toEqual(measured);
    expect(runBootstrap(JSON.stringify(measured)).properties.get("--mx-boot-period-figure")).toBe("40px");
    expect(runBootstrap(JSON.stringify(layout)).properties.has("--mx-boot-period-figure")).toBe(false);
    const invalid = { ...layout, reading: { ...layout.reading, periodFigure: 1000 } };
    expect(parseOverviewLayout(JSON.stringify(invalid))).toEqual(layout);
  });

  it("applies validated sector and brief geometry independently", () => {
    const raw = JSON.stringify({ ...layout, reading: null, sectors: 392.5, brief: 82, content: "Synthetic brief text" });
    expect(parseOverviewLayout(raw)).toEqual({ rows: layout.rows, ledger: layout.ledger, sectors: 392.5, brief: 82 });
    const { properties } = runBootstrap(raw);
    expect(properties.get("--mx-boot-sectors-size")).toBe("392.5px");
    expect(properties.get("--mx-boot-brief-size")).toBe("82px");
    expect(properties.get("--mx-boot-brief-display")).toBe("block");
    expect(parseOverviewLayout(JSON.stringify({ ...layout, sectors: 2_001, brief: -1 }))).toEqual(layout);
  });

  it("migrates valid tab-local geometry and removes unsupported or other-workspace keys", () => {
    const raw = JSON.stringify(layout);
    const existing = prefix + "isa:zh:phone";
    const invalid = prefix + "fake:en:desktop";
    const otherScope = OVERVIEW_LAYOUT_VERSION_PREFIX + "b".repeat(64) + ":";
    const foreign = otherScope + "total:en:desktop";
    const { properties, session, persisted } = runBootstrap(
      undefined, { [key]: raw, [foreign]: raw, [existing]: raw },
      { [existing]: JSON.stringify({ rows: { stocks: 4, funds: 0 } }), [invalid]: raw, [foreign]: raw,
        [OVERVIEW_LAYOUT_ACTIVE_KEY]: otherScope },
    );
    expect(properties.get("--mx-boot-ledger-rows")).toBe("20");
    expect(persisted.getItem(key)).toBe(raw);
    expect(persisted.getItem(existing)).toBe(JSON.stringify({ rows: { stocks: 4, funds: 0 } }));
    expect(persisted.getItem(invalid)).toBeNull();
    expect(persisted.getItem(foreign)).toBeNull();
    expect(persisted.getItem(OVERVIEW_LAYOUT_ACTIVE_KEY)).toBe(prefix);
    expect(persisted.getItem("trading_max-locale")).toBe("en");
    expect(Object.keys(session)).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["oversized record", "x".repeat(513)],
    ["invalid row count", '{"rows":{"stocks":-1,"funds":0}}'],
  ])(
    "migrates valid tab-local geometry when the destination contains %s", (_, invalid) => {
      const raw = JSON.stringify(layout);
      const { properties, session, persisted } = runBootstrap(invalid, { [key]: raw });
      expect(properties.get("--mx-boot-ledger-height")).toBe(layout.ledger + "px");
      expect(persisted.getItem(key)).toBe(raw);
      expect(session.getItem(key)).toBeNull();
    },
  );

  it("skips legacy geometry invalidated by a newer generation and prunes other workspace generations", () => {
    const generation = key + OVERVIEW_LAYOUT_GENERATION_SUFFIX;
    const foreign = OVERVIEW_LAYOUT_VERSION_PREFIX + "b".repeat(64) + ":total:en:desktop" + OVERVIEW_LAYOUT_GENERATION_SUFFIX;
    const { properties, session, persisted } = runBootstrap(undefined, { [key]: JSON.stringify(layout) },
      { [generation]: "current-generation", [foreign]: "foreign-generation" });
    expect(properties.has("--mx-boot-ledger-height")).toBe(false);
    expect(persisted.getItem(key)).toBeNull();
    expect(persisted.getItem(generation)).toBe("current-generation");
    expect(persisted.getItem(foreign)).toBeNull();
    expect(session.getItem(key)).toBeNull();
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
