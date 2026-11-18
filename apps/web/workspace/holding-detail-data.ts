import type { Holding } from "@/lib/types";
import { quoteUnit, quoteValue } from "./financial-values";

export function holdingQuote(holding: Pick<
  Holding,
  "priceCurrency" | "currentPrice" | "dilutedCostPerShareGbp" |
  "dilutedCostPerShareNative" | "dilutedCostCurrency"
>) {
  const { currentPrice, priceCurrency, dilutedCostPerShareGbp, dilutedCostPerShareNative, dilutedCostCurrency } = holding;
  const pence = quoteUnit(priceCurrency).divisor === 100;
  const foreign = !pence && priceCurrency !== "GBP";
  const raw = pence && Number.isFinite(currentPrice)
    ? quoteValue(currentPrice, priceCurrency, { style: "native" })
    : quoteValue(currentPrice, priceCurrency);
  return {
    raw,
    pence,
    foreign,
    price: quoteValue(currentPrice, priceCurrency),
    dilutedCost: foreign
      ? quoteValue(dilutedCostCurrency === priceCurrency ? dilutedCostPerShareNative : null, priceCurrency)
      : quoteValue(dilutedCostPerShareGbp, "GBP"),
  };
}

export function holdingQuantityUnit(isFund: boolean, locale: "zh" | "en", quantity: number) {
  const labels = locale === "zh"
    ? { fund: "份", share: "股" }
    : { fund: quantity === 1 ? "unit" : "units", share: quantity === 1 ? "share" : "shares" };
  return isFund ? labels.fund : labels.share;
}
