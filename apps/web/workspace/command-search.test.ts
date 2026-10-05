import { describe, expect, it } from "vitest";
import { highlightParts, needsSecurity, pageAliases, recentVisit, rememberVisit, searchWorkspace, type SearchPage, type SearchResult } from "./command-search";

const pages: SearchPage[] = [
  { href: "/", label: "组合总览", aliases: pageAliases["/"] },
  { href: "/research", label: "证券研究", aliases: pageAliases["/research"] },
  { href: "/holdings", label: "持仓与穿透", aliases: pageAliases["/holdings"] },
  { href: "/analytics", label: "收益与风险", aliases: pageAliases["/analytics"] },
];
const instruments = [
  { ticker: "ARM", name: "Arm Holdings" },
  { ticker: "BE", name: "Bloom Energy" },
  { ticker: "SEMI.AS", name: "Semiconductor ETF" },
];
const search = (query: string, currentTicker?: string, locale: "zh" | "en" = "zh") => searchWorkspace({ query, currentTicker, pages, instruments, recent: [], locale });

describe("workspace command search", () => {
  it.each([
    ["ARM 技术面", "/research?ticker=ARM&view=technical"],
    ["ARM技术面", "/research?ticker=ARM&view=technical"],
    ["technical arm", "/research?ticker=ARM&view=technical"],
    ["BE DCF", "/research?ticker=BE&view=valuation"],
    ["Bloom Energy 财务", "/research?ticker=BE&view=fundamentals"],
    ["SEMI.AS K线", "/research?ticker=SEMI.AS&view=technical"],
    ["ＡＲＭ technical", "/research?ticker=ARM&view=technical"],
    ["BE 期权链", "/research?ticker=BE&view=options"],
    ["BE 研究记录", "/research?ticker=BE&view=ledger"],
  ])("opens the existing lens for %s", (query, href) => {
    expect(search(query).find((item) => item.group === "research")?.href).toBe(href);
  });
  it.each([
    ["ETF", "/holdings?view=lookthrough"],
    ["穿透", "/holdings?view=lookthrough"],
    ["lookthrough", "/holdings?view=lookthrough"],
    ["TWR", "/analytics?view=returns"],
    ["收益对比", "/analytics?view=returns"],
    ["risk", "/analytics?view=risk"],
  ])("exposes the nested page for %s", (query, href) => {
    expect(search(query).some((item) => item.href === href)).toBe(true);
  });
  it("matches both languages regardless of current locale", () => {
    expect(search("research")[0]?.href).toBe("/research");
    expect(search("研究", undefined, "en")[0]?.href).toBe("/research");
  });
  it("ranks an exact ticker above incidental page alias matches", () => {
    expect(search("BE")[0]?.href).toBe("/research?ticker=BE");
  });
  it("does not guess a ticker or turn unmatched input into research", () => {
    expect(search("DCF").filter((item) => item.group === "research")).toEqual([]);
    expect(needsSecurity("DCF")).toBe(true);
    expect(search("UNKNOWN technical").filter((item) => item.group === "research")).toEqual([]);
    expect(search("technical", "UNKNOWN").filter((item) => item.group === "research")).toEqual([]);
  });
  it("uses an explicit current ticker for a bare lens", () => {
    expect(search("估值", "BE")[0]?.href).toBe("/research?ticker=BE&view=valuation");
    expect(needsSecurity("估值", "BE")).toBe(false);
  });
  it("keeps static pages available without the directory", () => {
    expect(searchWorkspace({ query: "twr", pages, instruments: [], recent: [], locale: "zh" })[0]?.href).toBe("/analytics?view=returns");
  });
  it("deduplicates recent pages and bounds history", () => {
    let recent: SearchResult[] = Array.from({ length: 8 }, (_, index) => ({ href: "/research?ticker=T" + index, label: "T" + index, group: "recent" as const }));
    recent = rememberVisit(recent, { href: "/research", label: "证券研究", group: "recent" });
    expect(recent).toHaveLength(6);
    expect(rememberVisit(recent, recent[0])).toHaveLength(6);
    const results = searchWorkspace({ query: "", pages, instruments, recent, locale: "zh" });
    expect(results[0].group).toBe("recent");
    expect(results.filter((item) => item.href === "/research")).toHaveLength(1);
  });
  it("retains only allowlisted locations, never raw searches or secrets", () => {
    expect(recentVisit("/holdings", new URLSearchParams("q=private&token=secret"), pages, "zh")?.href).toBe("/holdings");
    expect(recentVisit("/research", new URLSearchParams("ticker=ARM&view=technical&token=secret"), pages, "zh")?.href).toBe("/research?ticker=ARM&view=technical");
    expect(recentVisit("/research", new URLSearchParams("ticker=../private"), pages, "zh")).toBeNull();
    expect(recentVisit("/research", new URLSearchParams(), pages, "zh")).toBeNull();
    expect(recentVisit("/unknown", new URLSearchParams(), pages, "zh")).toBeNull();
  });
  it("highlights literal text safely, including regex symbols and markup", () => {
    expect(highlightParts("SEMI.AS", "SEMI.AS")).toEqual([{ text: "SEMI.AS", match: true }]);
    expect(highlightParts("SEMIxAS", "SEMI.AS")).toEqual([{ text: "SEMIxAS", match: false }]);
    expect(highlightParts("<script>", "<script>")).toEqual([{ text: "<script>", match: true }]);
    expect(highlightParts("Arm Holdings", "arm")[0]).toEqual({ text: "Arm", match: true });
    expect(highlightParts("[A]+", "[A]+")[0].match).toBe(true);
  });
});
