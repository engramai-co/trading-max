import type { CSSProperties } from "react";
import { heat, heatMix } from "./sectors-data";

type HeatStyle = CSSProperties & Record<"--mx-world-heat-light" | "--mx-world-heat-dark" | "--mx-world-hue", string>;

export function globalHeatStyle(change: number | null | undefined): HeatStyle {
  const value = heat(change);
  return {
    "--mx-world-heat-light": heatMix(change, "light"),
    "--mx-world-heat-dark": heatMix(change, "dark"),
    "--mx-world-hue": value > 0 ? "var(--mx-up)" : value < 0 ? "var(--mx-down)" : "var(--mx-world-land)",
  };
}
