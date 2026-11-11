import type { Holding } from "@/lib/types";
import { currency } from "./data";

const quoteNumber = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function holdingQuote(holding: Pick<
  Holding,
  "priceCurrency" | "currentPrice" | "dilutedCostPerShareGbp" |
  "dilutedCostPerShareNative" | "dilutedCostCurrency"
>) {
  const { currentPrice, priceCurrency, dilutedCostPerShareGbp, dilutedCostPerShareNative, dilutedCostCurrency } = holding;
  const pence = priceCurrency === "GBX" || priceCurrency === "GBp";
  const foreign = !pence && priceCurrency !== "GBP";
  const raw = pence && Number.isFinite(currentPrice)
    ? `${priceCurrency} ${quoteNumber.format(currentPrice)}`
    : currency(currentPrice, priceCurrency, 2);
  return {
    raw,
    pence,
    foreign,
    price: pence && Number.isFinite(currentPrice) ? currency(currentPrice / 100, "GBP", 2) : raw,
    dilutedCost: foreign
      ? currency(dilutedCostCurrency === priceCurrency ? dilutedCostPerShareNative : null, priceCurrency, 2)
      : currency(dilutedCostPerShareGbp, "GBP", 2),
  };
}

export function holdingQuantityUnit(isFund: boolean, locale: "zh" | "en", quantity: number) {
  const labels = locale === "zh"
    ? { fund: "份", share: "股" }
    : { fund: quantity === 1 ? "unit" : "units", share: quantity === 1 ? "share" : "shares" };
  return isFund ? labels.fund : labels.share;
}
