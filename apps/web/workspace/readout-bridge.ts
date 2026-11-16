import { readingText, type ChartReadout, type LegacyChartReadout, type ReadingTone } from "./chart-readout";

/**
 * Until plot.tsx renders a Reading, a structured readout also carries the legacy
 * string, so the same chart reads correctly before and after that change.
 */
export function bridgeReadout(readout: ChartReadout): ChartReadout & Pick<LegacyChartReadout, "point"> {
  return {
    ...readout,
    point: (position) => {
      const reading = readout.read(position);
      return reading ? readingText(reading) : "";
    },
  };
}

/** Gain and loss colours mark signed results only; zero and missing values stay in ink. */
export function readingTone(value: number | null | undefined): ReadingTone | undefined {
  return value == null || !Number.isFinite(value) || value === 0 ? undefined : value > 0 ? "up" : "down";
}

/** Readings and axes use the minus sign (U+2212), never a hyphen. */
export function minus(text: string) {
  return text.replace(/(^|[\s(+])-(?=[\d.£$€¥])/g, "$1−").replace(/^-/, "−");
}

/** Prices and other fixed-precision figures, with the minus sign. */
export function fixed(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return minus(value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

/** EPS keeps two decimals and shows a third only when it differs there. */
export function epsFigure(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return minus(value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
}
