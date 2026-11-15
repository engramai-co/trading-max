import { expect, it } from "vitest";
import { percentileBand } from "./percentile-band";

it("uses supplied quartiles, deciles and mean independently", () => {
  const sample = { median: 14, lowerQuartile: 10, upperQuartile: 20, lowerDecile: 6, upperDecile: 33, mean: 15, standardDeviation: 5 };
  expect(percentileBand(sample, "P25–P75")).toEqual({ low: 10, middle: 14, high: 20 });
  expect(percentileBand(sample, "P10–P90")).toEqual({ low: 6, middle: 14, high: 33 });
  expect(percentileBand(sample, "mean ±1σ")).toEqual({ low: 10, middle: 15, high: 20 });
  expect(percentileBand({ median: 14 }, "P10–P90")).toBeUndefined();
});
