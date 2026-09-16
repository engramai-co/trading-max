import { describe, expect, it } from "vitest";
import {
  incompletePriceRange,
  resolvePriceInterval,
  supportsPriceRange,
} from "./research-price-settings";

describe("security chart range and interval", () => {
  it("keeps the basic chart readable despite a saved advanced interval", () => {
    expect(resolvePriceInterval("3M", "15m", false)).toBe("1d");
    expect(resolvePriceInterval("1Y", "15m", true)).toBe("1d");
    expect(resolvePriceInterval("1M", "15m", true)).toBe("15m");
    expect(resolvePriceInterval("5D", null, false)).toBe("15m");
    expect(resolvePriceInterval("ALL", null, false)).toBe("1wk");
    expect(supportsPriceRange("60m", "2Y")).toBe(false);
    expect(supportsPriceRange("1wk", "1D")).toBe(false);
  });
  it("detects a quarter falsely presented as a year without flagging holidays", () => {
    expect(incompletePriceRange(["2026-06-17", "2026-09-11"], "1Y")).toBe(true);
    expect(incompletePriceRange(["2025-09-15", "2026-09-11"], "1Y")).toBe(
      false,
    );
    expect(incompletePriceRange(["2026-01-05", "2026-09-11"], "YTD")).toBe(
      false,
    );
    expect(
      incompletePriceRange(["2026-09-09", "2026-09-10", "2026-09-11"], "5D"),
    ).toBe(true);
  });
});
