import { expect, it } from "vitest";
import { sampleLine } from "./line-sampling";

it("keeps a 50,000 point silhouette, extrema, gap edges and event anchors", () => {
  const points = Array.from({ length: 50_000 }, (_, index) => ({
    index, value: index === 222 ? 12_000 : index === 18_888 ? -12_000
      : index >= 30_000 && index < 30_100 ? null : Math.sin(index * 0.01),
  }));
  const result = sampleLine(points, 390, (point) => point.index, (point) => point.value, (point) => point.index === 12_345);
  expect(result.length).toBeLessThanOrEqual(784);
  const indexes = result.map((point) => point.index);
  expect(indexes[0]).toBe(0);
  expect(indexes.at(-1)).toBe(49_999);
  expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
  expect(indexes).toEqual(expect.arrayContaining([222, 18_888, 12_345, 29_999, 30_000, 30_100]));
  expect(result.every((point) => point === points[point.index])).toBe(true);
});
