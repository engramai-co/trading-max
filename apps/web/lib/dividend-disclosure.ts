import type { Locale } from "@/components/locale-provider";

export function dividendAmount(amount: unknown, currency: unknown, unit: unknown, locale: Locale) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const code = typeof currency === "string" ? currency : "";
  const perShare = locale === "zh" ? "每股" : "per share";
  const label = unit === "per_share" ? perShare : typeof unit === "string" ? unit : "";
  return [code, String(amount), label].filter(Boolean).join(" ");
}

export function dividendBasis(basis: unknown, locale: Locale) {
  if (basis === "provider-adjusted-per-share") return locale === "zh" ? "数据源调整后的每股金额" : "Provider-adjusted per share";
  return typeof basis === "string" ? basis : null;
}
