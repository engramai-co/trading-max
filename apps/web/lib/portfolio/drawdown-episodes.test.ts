import { expect, it } from "vitest";
import { deepestDrawdown, drawdownEpisodes } from "./drawdown-episodes";

it("recognises an actual recovery and ties at the last recorded peak", () => {
  expect(drawdownEpisodes([0, 0, -0.1, -0.22, -0.04, 0, 0, -0.1])).toEqual([
    { peak: 1, trough: 3, depth: -0.22, recovery: 5, state: "recovered" },
    { peak: 6, trough: 7, depth: -0.1, recovery: null, state: "open" },
  ]);
});

it("does not claim a recovery or an earlier peak through a gap", () => {
  expect(deepestDrawdown([0, -0.22, null, -0.3, 0, -0.2])).toEqual({
    peak: 0, trough: 1, depth: -0.22, recovery: null, state: "interrupted",
  });
});
