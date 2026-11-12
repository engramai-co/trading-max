import { describe, expect, it } from "vitest";
import { packSnapshotCache, readSnapshotCache, snapshotCacheMaxAge, snapshotCacheMaxSize } from "./snapshot-cache";

const now = Date.parse("2026-11-12T12:00:00Z");
const brokerAsOf = "2026-11-10T15:00:00Z";
const dashboard = {
  key: ["dashboard-lens", "latest", "overview", null, { detail: "summary" }],
  data: { runId: "synthetic-run", brokerAsOf },
  updatedAt: now - 1_000,
};

describe("snapshot query persistence", () => {
  it("preserves the source time and saved query time, with strict connection and schema isolation", () => {
    const raw = packSnapshotCache([dashboard], "workspace-one", now);
    expect(readSnapshotCache(raw, "workspace-one", now)).toEqual([dashboard]);
    expect(readSnapshotCache(raw, "workspace-two", now)).toEqual([]);
    expect(readSnapshotCache(raw.replace('"version":1', '"version":0'), "workspace-one", now)).toEqual([]);
    expect(readSnapshotCache(raw.slice(0, -2), "workspace-one", now)).toEqual([]);
  });

  it("accepts research and history under their own snapshot identities", () => {
    const entries = [
      { ...dashboard, key: ["workspace-research-shell"],
        data: { status: { runId: "synthetic-run" }, instruments: [] } },
      { ...dashboard, key: ["workspace-research", "SYNTH", "overview", "summary", "synthetic-run"],
        data: { ticker: "SYNTH", view: "overview", runId: "synthetic-run", generatedAt: brokerAsOf } },
      { ...dashboard, key: ["portfolio-history", { runId: "synthetic-run", range: "3M", scope: "total" }],
        data: { runId: "synthetic-run", history: { timeline: { segments: [], rows: [] } }, money: {} } },
    ];
    expect(readSnapshotCache(packSnapshotCache(entries, "workspace-one", now), "workspace-one", now)).toEqual(entries);
  });

  it("drops expired, out-of-scope and mismatched snapshots even when storage already contains them", () => {
    const rejected = [
      { ...dashboard, updatedAt: now - snapshotCacheMaxAge },
      { ...dashboard, updatedAt: now + 1 },
      { ...dashboard, key: ["dashboard-lens", "snapshot", "synthetic-run", "overview", null, null] },
      { ...dashboard, key: ["workspace-prices", "SYNTH", "1d", "MAX", "synthetic-run"] },
      { ...dashboard, key: ["settings-integrations"] },
      { ...dashboard, key: ["openai-oauth", "synthetic"] },
      { ...dashboard, key: ["workspace-research", "SYNTH", "overview", "summary", "synthetic-run"],
        data: { ticker: "OTHER", view: "overview", runId: "synthetic-run", generatedAt: brokerAsOf } },
      { ...dashboard, key: ["portfolio-history", { runId: "other", scope: "total", range: "3M" }] },
    ];
    const raw = JSON.stringify({ version: 1, scope: "workspace-one", entries: [...rejected, dashboard] });
    expect(readSnapshotCache(raw, "workspace-one", now)).toEqual([dashboard]);
  });

  it("keeps only recent, unique keys within the byte budget and skips oversized responses", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      ...dashboard,
      key: ["workspace-research", "TEST" + i, "overview", "summary", "synthetic-run"],
      data: { ticker: "TEST" + i, view: "overview", runId: "synthetic-run", generatedAt: brokerAsOf },
      updatedAt: now - 2_000 + i,
    }));
    const newerDashboard = { ...dashboard, updatedAt: now - 500, data: { ...dashboard.data, totalValueGbp: 200 } };
    const raw = packSnapshotCache([dashboard, ...entries, newerDashboard, {
      ...dashboard, key: ["dashboard-lens", "latest", "review", null, null],
      data: { ...dashboard.data, synthetic: "资".repeat(snapshotCacheMaxSize / 2) },
    }], "workspace-one", now);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(snapshotCacheMaxSize);
    const restored = readSnapshotCache(raw, "workspace-one", now);
    expect(restored).toHaveLength(32);
    expect(restored[0]).toEqual(newerDashboard);
    expect(restored.at(-1)).toEqual(entries[9]);
  });
});
