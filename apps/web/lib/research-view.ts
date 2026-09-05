import type { ResearchInstrument } from "@/lib/types";

export function mergeResearchInstruments(
  sources: ResearchInstrument[][],
  removedTickers: ReadonlySet<string> = new Set(),
): ResearchInstrument[] {
  const merged = new Map<string, ResearchInstrument>();
  for (const instruments of sources) {
    for (const instrument of instruments) {
      if (!removedTickers.has(instrument.ticker)) {
        merged.set(instrument.ticker, instrument);
      }
    }
  }
  return Array.from(merged.values());
}

export function filterAndPrioritizeResearchInstruments(
  instruments: ResearchInstrument[],
  category: string,
): ResearchInstrument[] {
  return instruments
    .map((instrument, index) => ({ index, instrument }))
    .filter(
      ({ instrument }) =>
        category === "all" || instrument.categoryId === category,
    )
    .sort(
      (left, right) =>
        Number(right.instrument.held) - Number(left.instrument.held) ||
        left.index - right.index,
    )
    .map(({ instrument }) => instrument);
}

export function normalizedFundamentalMetrics(
  fundamentals: Record<string, unknown>,
): Record<string, number | string | null> {
  const legacy = fundamentals.info;
  const normalized = fundamentals.metrics;
  return {
    ...(normalized && typeof normalized === "object" ? normalized : {}),
    ...(legacy && typeof legacy === "object" ? legacy : {}),
  } as Record<string, number | string | null>;
}
