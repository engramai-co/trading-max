import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/workspace/data";
import { statementUnit, statementValue } from "./financial-values";
import { resolveResearchIdentity } from "./research-identity";

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

async function rejected(status: number, body: unknown, raw = false) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw ? String(body) : JSON.stringify(body), { status })));
  try { await api("/research/AAPL/models"); } catch (error) { return error; }
  throw new Error("Expected rejection");
}

describe("API validation failures", () => {
  it("preserves safe provider categories for actionable connection errors", async () => {
    const error = await rejected(422, { detail: { code: "provider_auth_failed", message: "Integration test failed" } });
    expect((error as ApiError).code).toBe("provider_auth_failed");
    const invalid = await rejected(422, { detail: { code: "private response / credential" } });
    expect((invalid as ApiError).code).toBeNull();
  });
  it("preserves field constraints from detail arrays without carrying rejected inputs", async () => {
    const error = await rejected(422, { detail: [{ loc: ["body", "scenarios", "bear", "discountRate"], type: "greater_than", msg: "private server detail", input: "private rejected input", ctx: { gt: 0, credentials: "private" } }] });
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).issues).toEqual([{ path: ["body", "scenarios", "bear", "discountRate"], type: "greater_than", bounds: { gt: 0 } }]);
    expect(JSON.stringify((error as ApiError).issues)).not.toContain("private");
  });
  it("preserves structured validation constraints for the current model endpoint", async () => {
    const error = await rejected(422, { detail: { message: "Rejected", errors: [
      { loc: ["scenarios", "base", "revenueCagr"], type: "less_than_equal", ctx: { le: 5 } },
      { loc: ["body", "scenarios", "bull", "exitFcfMultiple"], type: "float_parsing" },
      { loc: ["body", "credentials"], type: "missing" },
    ] } });
    expect((error as ApiError).issues).toEqual([
      { path: ["scenarios", "base", "revenueCagr"], type: "less_than_equal", bounds: { le: 5 } },
      { path: ["body", "scenarios", "bull", "exitFcfMultiple"], type: "float_parsing", bounds: {} },
      { path: ["body", "credentials"], type: "missing", bounds: {} },
    ]);
  });
  it("keeps non-JSON failures bounded and propagates network failures for retry", async () => {
    const error = await rejected(503, "<html>unavailable</html>", true);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).issues).toEqual([]);
    expect((error as ApiError).message).toBe("Request failed (503)");
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    await expect(api("/research/AAPL/models")).rejects.toBe(networkError);
  });
});
