import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./data";
import { statementUnit, statementValue } from "./financial-values";
import { resolveResearchIdentity } from "./research-identity";
import { assumptionChange, assumptionErrors } from "./valuation-assumptions";

const zh = (text: string) => text;
const en = (_zh: string, text: string) => text;
afterEach(() => vi.unstubAllGlobals());

describe("statement unit regressions", () => {
  it.each([
    "Net Income From Continuing Operations",
    "Net Income From Continuing Operation Net Minority Interest",
    "Net Income From Continuing And Discontinued Operation",
    "Net Income Continuous Operations",
    "Selling General And Administration",
  ])("keeps %s in monetary units", (field) => {
    expect(statementUnit(field)).toBe("money");
    expect(statementValue(112010000000, field, true)).toBe("112,010");
    expect(statementValue(112010000000, field, false)).toBe("112,010,000,000");
    expect(statementValue(-1000000, field, true)).toBe("-1");
    expect(statementValue(null, field, false)).toBe("—");
  });
  it("recognizes explicit units after case/whitespace normalization", () => {
    expect(statementValue(0.156, "  TAX Rate   For Calcs ", true)).toBe("15.6%");
    expect(statementValue(6.2, "Normalized Diluted EPS", true)).toBe("6.2");
    expect(statementValue(15000000, "Share Issued", true)).toBe("15");
    expect(statementValue(0, "Tax Rate For Calcs", false)).toBe("0.0%");
  });
});

describe("research deep links", () => {
  const instruments = ["AAPL", "VWRP.L", "BRK.B", "ABC.L", "ABC.AS"].map((ticker) => ({ ticker }));
  it.each([[" aapl ", "AAPL"], ["VWRP", "VWRP.L"], ["vwrp.l", "VWRP.L"], ["brk.b", "BRK.B"]])(
    "resolves %s to the listed identity %s", (requested, ticker) => {
      expect(resolveResearchIdentity(instruments, requested).selected?.ticker).toBe(ticker);
    },
  );
  it("requires a listing choice for ambiguous old symbols and respects exact identities", () => {
    expect(resolveResearchIdentity(instruments, "ABC")).toEqual({ selected: undefined, candidates: instruments.slice(3) });
    expect(resolveResearchIdentity([...instruments, { ticker: "ABC" }], "abc").selected?.ticker).toBe("ABC");
    expect(resolveResearchIdentity(instruments, "UNKNOWN")).toEqual({ selected: undefined, candidates: [] });
    expect(resolveResearchIdentity(instruments, "BRK").selected).toBeUndefined();
    expect(resolveResearchIdentity(instruments, "AAPL.L").selected).toBeUndefined();
  });
});

describe("assumption history display units", () => {
  it.each(["bear", "base", "bull"])("formats each %s field in editor units", (scenario) => {
    const labels = { bear: "保守情景", base: "基准情景", bull: "乐观情景" };
    for (const [key, label] of [["revenueCagr", "营收增长"], ["targetFcfMargin", "现金流率"], ["discountRate", "折现率"], ["shareCagr", "股数增长"]]) {
      expect(assumptionChange(`${scenario}.${key}`, null, 0.001, zh)).toBe(`${labels[scenario as keyof typeof labels]} · ${label}：未设置 → 0.1%`);
      expect(assumptionChange(`${scenario}.${key}`, -0.99, -0.985, zh)).toContain("-99% → -98.5%");
      expect(assumptionChange(`${scenario}.${key}`, 0, null, zh)).toContain("0% → 未设置");
    }
    expect(assumptionChange(`${scenario}.exitFcfMultiple`, null, 0, zh)).toContain("未设置 → 0×");
    expect(assumptionChange(`${scenario}.exitFcfMultiple`, 15, 20.25, en)).toContain("15× → 20.25×");
  });
  it("does not expose unknown storage keys or stringify objects", () => {
    expect(assumptionChange("future.rawKey", "private", { input: "private" }, zh)).toBe("其他假设已修改");
  });
});

async function rejected(status: number, body: unknown, raw = false) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw ? String(body) : JSON.stringify(body), { status })));
  try { await api("/valuation/assumptions/AAPL"); } catch (error) { return error; }
  throw new Error("Expected rejection");
}

describe("API validation failures", () => {
  it("preserves field constraints from detail arrays without carrying rejected inputs", async () => {
    const error = await rejected(422, { detail: [{ loc: ["body", "scenarios", "bear", "discountRate"], type: "greater_than", msg: "private server detail", input: "private rejected input", ctx: { gt: 0, credentials: "private" } }] });
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).issues).toEqual([{ path: ["body", "scenarios", "bear", "discountRate"], type: "greater_than", bounds: { gt: 0 } }]);
    const formatted = assumptionErrors(error, zh);
    expect(formatted.fields).toEqual({ "bear.discountRate": "需大于 0%" });
    expect(formatted.message).toContain("修改标出的项目");
    expect(JSON.stringify(formatted)).not.toContain("private");
  });
  it("supports structured errors and converts numeric constraints to field units", async () => {
    const error = await rejected(422, { detail: { message: "Rejected", errors: [
      { loc: ["scenarios", "base", "revenueCagr"], type: "less_than_equal", ctx: { le: 5 } },
      { loc: ["body", "scenarios", "bull", "exitFcfMultiple"], type: "float_parsing" },
      { loc: ["body", "credentials"], type: "missing" },
    ] } });
    expect(assumptionErrors(error, en).fields).toEqual({ "base.revenueCagr": "Must be at most 500%", "bull.exitFcfMultiple": "Enter a valid number" });
  });
  it("localizes unknown server structures, non-JSON failures and network errors while preserving retry", async () => {
    for (const body of [{ detail: "private detail" }, { detail: { message: "private detail" } }, { detail: [{ msg: "private detail" }] }, { detail: { unexpected: "private detail" } }]) {
      const formatted = assumptionErrors(await rejected(422, body), zh);
      expect(formatted.fields).toEqual({});
      expect(formatted.message).toContain("重试");
      expect(formatted.message).not.toMatch(/private|422|Request failed/);
    }
    expect(assumptionErrors(await rejected(503, "<html>unavailable</html>", true), zh).message).toContain("暂时无法保存");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    let error: unknown;
    try { await api("/valuation/assumptions/AAPL"); } catch (caught) { error = caught; }
    expect(assumptionErrors(error, zh).message).toContain("修改仍保留");
  });
});
