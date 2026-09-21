import { numeric } from "@/lib/numeric";
import { object, objects, str, type Json } from "@/workspace/data";

export function reviewHighlights(review: Json, cfd: boolean) {
  const attribution = object(review.attribution);
  const instruments =
    attribution.status === "unavailable"
      ? []
      : objects(
          cfd
            ? attribution.byInstrument
            : object(attribution.by_instrument).buckets,
        ).flatMap((row) => {
          const value = numeric(cfd ? row.netRealisedPnl : row.netResultGbp);
          const label = str(row.label) || str(row.key);
          return value == null || !label ? [] : [{ label, value }];
        });
  const phases = object(review.phases);
  const periods =
    phases.status === "unavailable"
      ? []
      : objects(phases.items).flatMap((row) => {
          const value = numeric(cfd ? row.realisedPnlGbp : row.netPnlGbp);
          return value == null
            ? []
            : [
                {
                  id: str(row.phaseId),
                  value,
                  start: str(row.startDate),
                  end: str(row.endDate),
                },
              ];
        });
  return {
    contributor:
      instruments
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value)[0] ?? null,
    detractor:
      instruments
        .filter((row) => row.value < 0)
        .sort((a, b) => a.value - b.value)[0] ?? null,
    phase:
      periods.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0] ?? null,
    attributionPartial:
      attribution.status === "partial" || attribution.partial === true,
    phasesPartial: phases.status === "partial" || phases.partial === true,
    hasInstruments: instruments.length > 0,
  };
}
