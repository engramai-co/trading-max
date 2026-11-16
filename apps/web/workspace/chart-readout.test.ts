import { describe, expect, it } from "vitest";
import { readingRows } from "./chart-readout";

describe("readingRows", () => {
  it("names the point first and aligns label and value lines", () => {
    expect(readingRows("16 Nov 2026, 01:50 GMT\nPeriod net P&L: £187.82 GBP\nOpen 120.5")).toEqual({
      heading: "16 Nov 2026, 01:50 GMT",
      rows: [{ label: "Period net P&L", value: "£187.82 GBP" }, { text: "Open 120.5" }],
    });
  });

  it("keeps clock times and single-line readings intact", () => {
    expect(readingRows("13 Nov · MSCI World 4,870.41")).toEqual({ heading: "", rows: [{ text: "13 Nov · MSCI World 4,870.41" }] });
    expect(readingRows("13 Nov\nAt 10:30 close")).toEqual({ heading: "13 Nov", rows: [{ text: "At 10:30 close" }] });
    expect(readingRows("")).toEqual({ heading: "", rows: [] });
  });
});
