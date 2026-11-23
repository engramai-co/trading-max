import type { DashboardLens, Holding } from "@/lib/types";
import { quoteUnit, quoteValue } from "./financial-values";

export type HoldingPeekQuote = {
  price: number;
  currency: string;
  move: number | null;
  moveDay: string | null;
  closed: boolean;
  account: string;
  asOf: string | null | undefined;
  cited?: boolean;
};

export function holdingPositionAsOf(
  holding: Pick<Holding, "account">,
  lens?: Pick<DashboardLens, "positionAsOf" | "accounts">,
) {
  return lens?.positionAsOf && (holding.account === "A" || holding.account === "B")
    ? lens.positionAsOf[holding.account]
    : lens?.accounts?.find(({ code }) => code === holding.account)?.asOf;
}

export function holdingPeekQuote(
  holding: Holding,
  lens: Pick<DashboardLens, "positionAsOf" | "accounts"> | undefined,
  accountLabel: string,
  cited = false,
): HoldingPeekQuote {
  return {
    price: holding.currentPrice,
    currency: holding.priceCurrency,
    move: holding.dayChangePct ?? null,
    moveDay: holding.dayChangeClosedOn ?? holding.dayChangeDate ?? null,
    closed: Boolean(holding.dayChangeClosedOn),
    account: accountLabel,
    asOf: holdingPositionAsOf(holding, lens),
    cited,
  };
}

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
