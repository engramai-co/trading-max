import { describe, expect, it } from "vitest";
import { auxiliaryPage, desktopPage, presentationLink } from "./desktop-routing";
import { activityState } from "./desktop-status";
import type { HealthDetails, RefreshJob } from "@/lib/types";

describe("desktop presentation isolation", () => {
  it("never changes ordinary browser navigation, queries, or external links", () => {
    for (const path of ["/", "/health", "/settings", "/desktopish"]) {
      for (const href of ["/settings?tab=models", "/health", "https://example.com/", "//example.com/path"]) {
        expect(presentationLink(path, href)).toEqual({ href, separate: false });
      }
    }
  });
  it("keeps reports in the workspace and preserves filters", () => {
    expect(presentationLink("/desktop", "/analytics?range=5D&scope=isa#chart")).toEqual({ href: "/desktop/analytics?range=5D&scope=isa#chart", separate: false });
    expect(presentationLink("/desktop/research", "/research?ticker=SMGB").separate).toBe(false);
  });
  it("opens separate surfaces only when crossing a surface boundary", () => {
    expect(presentationLink("/desktop", "/settings?tab=models")).toEqual({ href: "/desktop/settings?tab=models", separate: true });
    expect(presentationLink("/desktop/imports", "/health?scope=cfd")).toEqual({ href: "/desktop/activity?scope=cfd", separate: true });
    expect(presentationLink("/desktop/settings", "/settings?tab=accounts").separate).toBe(false);
    expect(presentationLink("/desktop/activity", "/").separate).toBe(true);
    expect(presentationLink("/desktop", "/api/backend/refresh")).toEqual({ href: "/api/backend/refresh", separate: false });
    expect(desktopPage("/desktop/unknown")).toBeNull();
    expect(auxiliaryPage("/settings")).toBeNull();
  });
});

const job = (scope: RefreshJob["scope"], status: RefreshJob["status"], day: number) => ({ scope, status, createdAt: `2026-09-${day}T00:00:00Z`, jobId: `${scope}-${day}` }) as RefreshJob;
const details = (jobs: RefreshJob[]) => ({ jobs, errors: [], refresh: null, health: { queue: { running: 0, queued: 0 } } }) as unknown as HealthDetails;
describe("activity meaning", () => {
  it("does not let a later successful balance refresh erase failed history or performance", () => {
    const state = activityState(details([job("live", "succeeded", 29), job("performance", "failed", 28), job("accounts", "interrupted", 27)]));
    expect(state.failures.map((j) => j.scope)).toEqual(["performance", "accounts"]);
    expect(state.tone).toBe("degraded");
  });
  it("clears an old failure once the same scope succeeds, not from cumulative failure counters", () => {
    expect(activityState(details([job("accounts", "failed", 27), job("accounts", "succeeded", 28)])).failures).toEqual([]);
  });
  it("retains schedule failures outside the short recent-jobs list", () => {
    const data = details([job("live", "succeeded", 29)]);
    data.refresh = { performance: { lastJob: job("performance", "failed", 25) } } as HealthDetails["refresh"];
    expect(activityState(data).failures[0].scope).toBe("performance");
  });
});
