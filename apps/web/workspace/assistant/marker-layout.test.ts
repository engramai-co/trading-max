import { expect, it } from "vitest";
import { placeMarkers } from "./marker-layout";

it("keeps each adjacent candle reachable at the top and inside the chart", () => {
  for (const high of [14, 130]) {
    const points = [0,1,2].map(i => ({date:String(i),number:i+1,x:10+i,high}));
    const placed = placeMarkers(points,200);
    expect(placed.map(p => p.x)).toEqual(points.map(p => p.x));
    expect(placed.every(p => p.high === high && p.y >= 10 && p.y <= 190)).toBe(true);
    for (const a of placed) for (const b of placed) if (a !== b) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(28);
  }
});
