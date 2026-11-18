import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ResearchPriceSeries } from "@/lib/types";
import { ArchivedTradeRows } from "./research-price-events";

let locale: "zh" | "en";
vi.mock("@/components/locale-provider", async (original) => ({
  ...await original<typeof import("@/components/locale-provider")>(),
  useLocale: () => ({ locale }),
}));

const marker: NonNullable<ResearchPriceSeries["tradeMarkers"]>[number] = {
  ticker: "SYN", date: "2026-10-30", kind: "T", accounts: ["isa"],
  buyOrders: 2, buyQuantity: 3, sellOrders: 2, sellQuantity: 3.25,
  buyAveragePrice: null, sellAveragePrice: null,
  fills: [{ at: "2026-10-30T15:00:00Z", account: "isa", side: "buy", quantity: 2, amount: 10, currency: "GBP" }],
};

it.each([
  ["en", "Buy 1 share", "1 order", "Sell 3.25 shares", "2 orders"],
  ["zh", "买入 1 股", "1 笔", "卖出 3.25 股", "2 笔"],
] as const)("renders each archived quantity with its order count in %s", (language, buy, single, sell, multiple) => {
  locale = language;
  const html = renderToStaticMarkup(createElement(ArchivedTradeRows, { marker, date: marker.date }));
  expect(html).toContain(`<span>${buy}</span><span>${single}</span>`);
  expect(html).toContain(`<span>${sell}</span><span>${multiple}</span>`);
});
