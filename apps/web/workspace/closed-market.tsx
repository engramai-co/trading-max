import { useCopy } from "./foundation";

export function ClosedMarket() {
  const t = useCopy();
  return (
    <span className="mx-muted">
      <span aria-hidden="true">{t("休市", "Closed")}</span>
      <span className="sr-only">{t("该上市交易所休市", "This listing’s exchange was closed")}</span>
    </span>
  );
}
