import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDashboardLens } from "@/lib/dashboard-lenses";
import { ApiError, isReadTimeout } from "@/workspace/data";

afterEach(() => vi.unstubAllGlobals());

describe("fetchDashboardLens", () => {
  it.each([408, 504])("preserves HTTP %d on ApiError so read timeouts are recognized", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Timed out" }), { status })),
    );
    let caught: unknown;
    try {
      await fetchDashboardLens("overview", undefined, { detail: "summary" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(status);
    expect(isReadTimeout(caught)).toBe(true);
  });

  it("preserves non-timeout HTTP errors without classifying them as timeouts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Unavailable" }), { status: 503 })),
    );
    let caught: unknown;
    try {
      await fetchDashboardLens("overview");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect(isReadTimeout(caught)).toBe(false);
  });

  it("rejects mismatched cited publications", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ runId: "other-run" })),
    );
    await expect(
      fetchDashboardLens("overview", "A", { detail: "summary" }, undefined, "cited-run"),
    ).rejects.toThrow("Cited publication unavailable");
  });
});
