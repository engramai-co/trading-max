import { describe, expect, it } from "vitest";
import { reviewHighlights } from "./review-highlights";

describe("review highlights", () => {
  it("selects signed realized contributors and the largest absolute phase, without sorting the source", () => {
    const buckets = [
      { key: "SMALL", netResultGbp: 20 },
      { key: "LOSS", netResultGbp: -80 },
      { key: "WIN", netResultGbp: 50 },
      { key: "GAP", netResultGbp: null },
    ];
    const result = reviewHighlights(
      {
        attribution: { by_instrument: { buckets } },
        phases: { items: [{ netPnlGbp: 10 }, { netPnlGbp: -100 }] },
      },
      false,
    );
    expect(result.contributor).toEqual({ label: "WIN", value: 50 });
    expect(result.detractor).toEqual({ label: "LOSS", value: -80 });
    expect(result.phase?.value).toBe(-100);
    expect(buckets[0].key).toBe("SMALL");
  });
  it("does not label a loss as a contribution, or missing data as zero", () => {
    const result = reviewHighlights(
      {
        attribution: {
          by_instrument: {
            buckets: [
              { key: "LOSS", netResultGbp: -8 },
              { key: "GAP", netResultGbp: "" },
            ],
          },
        },
      },
      false,
    );
    expect(result.contributor).toBeNull();
    expect(result.phase).toBeNull();
    expect(reviewHighlights({}, false).hasInstruments).toBe(false);
  });
  it("uses the CFD realized contracts and preserves zero and partial coverage", () => {
    const result = reviewHighlights(
      {
        attribution: {
          status: "partial",
          byInstrument: [
            { key: "TEST", netRealisedPnl: 40, netResultGbp: 999 },
          ],
        },
        phases: {
          items: [
            {
              realisedPnlGbp: 0,
              netPnlGbp: 999,
              startDate: "2025-01-01",
              endDate: "2025-02-01",
            },
          ],
        },
      },
      true,
    );
    expect(result.contributor?.value).toBe(40);
    expect(result.phase).toEqual({
      id: "",
      value: 0,
      start: "2025-01-01",
      end: "2025-02-01",
    });
    expect(result.attributionPartial).toBe(true);
  });
  it("does not summarize explicitly unavailable sections", () => {
    const result = reviewHighlights(
      {
        attribution: {
          status: "unavailable",
          by_instrument: { buckets: [{ key: "OLD", netResultGbp: 500 }] },
        },
        phases: { status: "unavailable", items: [{ netPnlGbp: 500 }] },
      },
      false,
    );
    expect(result.contributor).toBeNull();
    expect(result.phase).toBeNull();
  });
});
