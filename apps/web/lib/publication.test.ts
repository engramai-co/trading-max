import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/ui/query-client";
import { publicationFromHealth, watchPublications, type Publication } from "./publication";
import { refreshPublicationQueries } from "./publication-queries";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("publication watcher", () => {
  function setup(read = vi.fn<(signal: AbortSignal) => Promise<Publication>>(async () => ({ runId: "one" }))) {
    let visible = true;
    const success = vi.fn();
    const fail = vi.fn();
    const watcher = watchPublications(read, success, fail, () => visible);
    watcher.wake();
    return { ...watcher, read, success, fail, show(value: boolean) { visible = value; watcher.wake(); } };
  }

  it("pauses while hidden and coalesces wake events when shown", async () => {
    const watcher = setup();
    await vi.advanceTimersByTimeAsync(1_000);
    watcher.wake();
    watcher.wake();
    watcher.wake();
    expect(watcher.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(watcher.read).toHaveBeenCalledTimes(2);
    watcher.show(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(watcher.read).toHaveBeenCalledTimes(2);
    watcher.show(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.read).toHaveBeenCalledTimes(3);
    watcher.dispose();
  });

  it("bounds stalled requests and backs off to a five minute cap", async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<Publication>>(() => new Promise<Publication>(() => {}));
    const watcher = setup(read);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    expect(watcher.fail).toHaveBeenCalledTimes(1);
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const previous = read.mock.calls.length;
      watcher.wake();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(read).toHaveBeenCalledTimes(previous);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(previous + 1);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    watcher.dispose();
  });

  it("aborts and discards a late response after hiding or disposal", async () => {
    const resolve: Array<(value: Publication) => void> = [];
    const read = vi.fn<(signal: AbortSignal) => Promise<Publication>>(() => new Promise<Publication>((done) => { resolve.push(done); }));
    const watcher = setup(read);
    watcher.show(false);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    resolve[0]({ runId: "late" });
    await vi.advanceTimersByTimeAsync(11_000);
    watcher.show(true);
    expect(read).toHaveBeenCalledTimes(2);
    watcher.dispose();
    expect(read.mock.calls[1][0].aborted).toBe(true);
    resolve[1]({ runId: "later" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(watcher.success).not.toHaveBeenCalled();
    expect(watcher.fail).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("wakes promptly after a hide and show in the same turn", async () => {
    const watcher = setup();
    watcher.show(false);
    watcher.show(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watcher.read).toHaveBeenCalledTimes(2);
    expect(watcher.success).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it("accepts an empty workspace but rejects non-health responses", () => {
    expect(publicationFromHealth({ service: "trading_max-api", status: "degraded", latestRunId: null })).toEqual({ runId: null });
    expect(() => publicationFromHealth({ service: "trading_max-api", status: "ok", latestRunId: "../other" })).toThrow();
    expect(() => publicationFromHealth({ latestRunId: "one" })).toThrow();
  });
});

describe("publication reconciliation", () => {
  function fixture() {
    const client = createQueryClient();
    const subscriptions: Array<() => void> = [];
    function active<T>(queryKey: readonly unknown[], initialData: T, queryFn: () => Promise<T>) {
      const observer = new QueryObserver(client, { queryKey, initialData, queryFn, staleTime: Infinity, retry: false });
      subscriptions.push(observer.subscribe(() => {}));
    }
    return { client, active, close() { subscriptions.forEach((unsubscribe) => unsubscribe()); client.clear(); } };
  }

  it("does no work on an unchanged run and refreshes only active latest readers on a new run", async () => {
    const { client, active, close } = fixture();
    const lens = vi.fn(async () => ({ runId: "two" }));
    const shell = vi.fn(async () => ({ status: { runId: "two" } }));
    const history = vi.fn(async () => ({}));
    const settings = vi.fn(async () => ({}));
    const overview = ["dashboard-lens", "latest", "overview"];
    active(overview, { runId: "one" }, lens);
    active(["workspace-research-shell"], { status: { runId: "one" } }, shell);
    active(["portfolio-history", { runId: "one" }], {}, history);
    active(["workspace-settings"], {}, settings);
    const inactive = ["dashboard-lens", "latest", "analytics"];
    client.setQueryData(inactive, { runId: "one" });

    await refreshPublicationQueries(client, "one");
    expect(lens).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    await refreshPublicationQueries(client, "two");
    await refreshPublicationQueries(client, "two");
    expect(lens).toHaveBeenCalledTimes(1);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(overview)).toEqual({ runId: "two" });
    expect(client.getQueryState(inactive)?.isInvalidated).toBe(false);
    expect(history).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    close();
  });

  it("catches up after a failed read even when the observed marker stays unchanged", async () => {
    const { client, active, close } = fixture();
    const key = ["dashboard-lens", "latest", "review"];
    const read = vi.fn(async () => ({ runId: "two" })).mockRejectedValueOnce(new Error("temporarily unavailable"));
    active(key, { runId: "one" }, read);
    await refreshPublicationQueries(client, "two");
    expect(client.getQueryState(key)?.status).toBe("error");
    expect(client.getQueryData(key)).toEqual({ runId: "one" });
    await refreshPublicationQueries(client, "two");
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toEqual({ runId: "two" });
    close();
  });

  it("lets the existing first-sync confirmation finish before refreshing Overview", async () => {
    const { client, active, close } = fixture();
    const lens = vi.fn(async () => ({ runId: "first-run" }));
    const onboarding = ["local-onboarding"];
    active(["dashboard-lens", "latest", "overview"], { runId: "" }, lens);
    active(onboarding, { confirmed: false }, async () => ({ confirmed: false }));
    await refreshPublicationQueries(client, "first-run");
    expect(lens).not.toHaveBeenCalled();
    client.setQueryData(onboarding, { confirmed: true });
    await refreshPublicationQueries(client, "first-run");
    expect(lens).toHaveBeenCalledTimes(1);
    close();
  });
});
