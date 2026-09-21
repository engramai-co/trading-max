import { compact, number } from "@/workspace/data";
import { numeric } from "@/lib/numeric";

/** Compact display only: source records and copy/export retain their precision. */
export function chartNumber(value: unknown) {
  const n = numeric(value);
  return n == null ? "—" : Math.abs(n) >= 10_000 ? compact(n) : number(n, 2);
}

export function chartName(name: string, width = 24) {
  if (name.length <= width) return name;
  const space = name.lastIndexOf(" ", width);
  const split = space > width / 2 ? space : width;
  const remainder = name.slice(split).trim();
  return (
    name.slice(0, split) +
    "\n" +
    (remainder.length <= width
      ? remainder
      : remainder.slice(0, width - 1) + "…")
  );
}
