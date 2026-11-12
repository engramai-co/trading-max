import { expect, test } from "vitest";
import { globalHeatStyle } from "./global-markets-data";

test("world map mixes into neutral land, respects the flat band and saturates at three percent", () => {
  for (const value of [undefined, null, NaN, 0, 0.0005, -0.0005]) {
    expect(globalHeatStyle(value)).toEqual({
      "--mx-world-heat-light": "0%", "--mx-world-heat-dark": "0%", "--mx-world-hue": "var(--mx-world-land)",
    });
  }
  expect(globalHeatStyle(-0.03)).toEqual(globalHeatStyle(-0.07));
  expect(globalHeatStyle(0.03)).toEqual(globalHeatStyle(0.07));
  expect(globalHeatStyle(-0.01)["--mx-world-hue"]).toBe("var(--mx-down)");
  expect(globalHeatStyle(0.01)["--mx-world-hue"]).toBe("var(--mx-up)");
});
