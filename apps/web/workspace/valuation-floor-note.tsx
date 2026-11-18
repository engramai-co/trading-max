import { useCopy } from "./foundation";

export function ValuationFloorNote({ adjustment = 0 }: { adjustment?: number }) {
  const t = useCopy();
  return adjustment > 0
    ? <span className="mx-valuation-floor">{t("股权估值为负，按零计", "Negative equity value floored at zero")}</span>
    : null;
}
