import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDashboardLens } from "@/lib/dashboard-lenses";
import { ApiError, isReadTimeout } from "@/workspace/data";

afterEach(() => vi.unstubAllGlobals());

const overview = {
  view: "overview", runId: "synthetic-overview", generatedAt: "2026-11-20T12:00:00Z",
  brokerAsOf: "", researchAsOf: "",
};

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

  it.each(["view", "generatedAt", "researchAsOf"] as const)("rejects an Overview payload missing %s", async (field) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...overview, [field]: undefined })));
    await expect(fetchDashboardLens("overview")).rejects.toThrow("Invalid Overview snapshot");
  });

  it.each(["brokerAsOf", "generatedAt", "researchAsOf"] as const)("rejects an invalid Overview %s", async (field) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...overview, [field]: "not-a-timestamp" })));
    await expect(fetchDashboardLens("overview")).rejects.toThrow("Invalid Overview snapshot");
  });

  it.each(["dayChangeClosedOn", "dayChangeDate"] as const)("rejects a non-string holding %s", async (field) => {
    const holding = { account: "A", ticker: "SYN", name: "Synthetic holding", [field]: 42 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...overview, holdings: [holding] })));
    await expect(fetchDashboardLens("overview")).rejects.toThrow("Invalid Overview snapshot");
  });

  it("accepts empty source times and omitted default collections", async () => {
    const empty = { ...overview, generatedAt: "" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(empty)));
    await expect(fetchDashboardLens("overview")).resolves.toEqual(empty);
  });
});
