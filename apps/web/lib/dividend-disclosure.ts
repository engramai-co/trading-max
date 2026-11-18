import type { Locale } from "@/components/locale-provider";

export function dividendAmount(amount: unknown, currency: unknown, unit: unknown, locale: Locale) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || unit !== "per_share") return null;
  const perShare = locale === "zh" ? "每股" : "per share";
  return [currency, String(amount), perShare].join(" ");
}

export function dividendBasis(basis: unknown, locale: Locale) {
  if (basis === "provider-adjusted-per-share") return locale === "zh" ? "数据源调整后的每股金额" : "Provider-adjusted per share";
  return typeof basis === "string" ? basis : null;
}
