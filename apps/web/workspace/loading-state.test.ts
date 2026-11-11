import { afterEach, describe, expect, it, vi } from "vitest";
import { previousForIdentity, scheduleLoadingStatus, updateFailureLabel } from "./loading-state";

describe("loading continuity", () => {
  afterEach(() => vi.useRealTimers());

  it("announces a long read only once and cancels the announcement for a fast read", () => {
    vi.useFakeTimers();
    const fast = vi.fn();
    const slow = vi.fn();
    const cancel = scheduleLoadingStatus(fast);
    scheduleLoadingStatus(slow);
    vi.advanceTimersByTime(149);
    cancel();
    vi.advanceTimersByTime(650);
    expect(slow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(slow).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(800);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).not.toHaveBeenCalled();
  });

  it("retains readings only for the identical listing", () => {
    const readings = { price: 104 };
    expect(previousForIdentity(readings, "NVDA", "NVDA")).toBe(readings);
    expect(previousForIdentity(readings, "NVDA", "VWRP.L")).toBeUndefined();
    expect(previousForIdentity(readings, "VWRP", "VWRP.L")).toBeUndefined();
    expect(previousForIdentity(readings, undefined, "NVDA")).toBeUndefined();
  });

  it("shows the last successful read in the display zone and language", () => {
    const at = Date.parse("2026-07-20T23:42:00Z");
    expect(updateFailureLabel(at, "zh", "Europe/London")).toBe("更新失败 · 上次成功 00:42");
    expect(updateFailureLabel(at, "en", "America/New_York")).toBe("Update failed · last success 19:42");
  });
});
