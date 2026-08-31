import type { ResearchInstrument } from "@/lib/types";

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
