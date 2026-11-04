import { describe, expect, it } from "vitest";
import { indicatorStart } from "./selection-indicator";

describe("selection indicator start frame", () => {
  it("starts a bottom-anchored tab underline level with the tabs", () => {
    // Tabs at top 50 in a 44px row: the 2px underline sits at 92 under each tab.
    // Measured from the list's top, the start frame used to drop it 42px lower.
    const first = { left: 24, top: 92, width: 56, height: 2 };
    const second = { left: 104, top: 92, width: 72, height: 2 };
    expect(indicatorStart(first, second, { x: 80, y: 0 })).toBe("translate(0px, 0px) scale(" + 56 / 72 + ", 1)");
  });

  it("slides a segment highlight from its former box", () => {
    const from = { left: 110, top: 54, width: 40, height: 28 };
    const to = { left: 150, top: 54, width: 50, height: 28 };
    expect(indicatorStart(from, to, { x: 44, y: 4 })).toBe("translate(4px, 4px) scale(0.8, 1)");
  });

  it("continues from mid-flight and skips a move that shows nothing", () => {
    // Half way to the second tab, a new choice returns to the first.
    const midway = { left: 64, top: 92, width: 64, height: 2 };
    const home = { left: 24, top: 92, width: 56, height: 2 };
    expect(indicatorStart(midway, home, { x: 0, y: 0 })).toBe("translate(40px, 0px) scale(" + 64 / 56 + ", 1)");
    expect(indicatorStart(home, { ...home, left: 24.3 }, { x: 0, y: 0 })).toBeNull();
    expect(indicatorStart(home, { ...home, width: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});
