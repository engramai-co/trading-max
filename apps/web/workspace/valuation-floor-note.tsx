import { useCopy } from "./foundation";

export function ValuationFloorNote({ adjustment = 0, pending }: { adjustment?: number; pending?: boolean }) {
  const t = useCopy();
  const label = t("股权估值为负，按零计", "Negative equity value floored at zero");
  if (adjustment > 0) return <span className="mx-valuation-floor">{label}</span>;
  // The live readout measures the translation even before the preview returns.
  return pending === undefined ? null : <span className="mx-valuation-floor" aria-hidden="true"
    data-label={label} data-pending={pending || undefined} />;
}
