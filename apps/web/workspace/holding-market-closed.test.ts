"use client";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as el, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { LocaleProvider } from "@/components/locale-provider";
import type { Holding } from "@/lib/types";
import { HoldingDetail } from "./holding-detail";
import { HoldingsWorkspace } from "./holdings";
import { OverviewHoldings } from "./overview-holdings";

const { day, positions } = vi.hoisted(() => ({ day: "2026-11-26", positions: [] as Holding[] }));
const holding: Holding = {
  ticker: "SYN", name: "Synthetic US stock", account: "A", listingMarket: "US",
  isFund: false, quantity: 2, currentPrice: 25, priceCurrency: "USD",
  currentValueGbp: 40, costGbp: 30, pnlGbp: 10, pnlPct: 1 / 3, allocationPct: 0.5,
  dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null,
  dilutedCostCurrency: "USD", snapshotFxRateNativePerGbp: null, fxImpactGbp: null,
  dayChangeClosedOn: day, dayChangeGbp: null, dayChangePct: null,
};
const closed = '<span class="mx-muted"><span aria-hidden="true">休市</span><span class="sr-only">该上市交易所休市</span></span>';
const zero = { ...holding, ticker: "FLT", dayChangeClosedOn: undefined, dayChangeDate: day, dayChangeGbp: 0, dayChangePct: 0 };

vi.mock("@/lib/dashboard-lenses", () => ({
  useDashboardLens: () => ({ data: { holdings: positions } }),
}));
vi.mock("./route-state", () => ({ useRouteState: () => ({ params: new URLSearchParams(), update: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./current-day", () => ({ useCurrentDay: () => ({ today: day, now: Date.parse(day) }) }));
vi.mock("@/ui/pointer", () => ({ useFinePointer: () => true }));
vi.mock("@mantine/core", async (importOriginal) => {
  const mantine = await importOriginal<typeof import("@mantine/core")>();
  // Mount the hover content inline for this server render. Playwright checks the live portal.
  const part = ({ children }: { children: ReactNode }) => el("div", null, children);
  return { ...mantine, HoverCard: Object.assign(part, { Target: part, Dropdown: part }) };
});

function render(child: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(el(MantineProvider, {},
    el(QueryClientProvider, { client: query }, el(LocaleProvider, { children: child }))));
}

it("replaces the overview desktop cell and phone reading without recoloring a normal zero", () => {
  const html = render(el(OverviewHoldings, { holdings: [holding, zero], account: "all" }));
  expect(html).toContain(closed + "</td>");
  expect(html).toContain(closed + "</dd>");
  expect(html.match(/>0\.00%<\/span><\/td>/g)).toHaveLength(1);
});

it("uses the same result in the overview hover preview", () => {
  const html = render(el(OverviewHoldings, { holdings: [holding], account: "all" }));
  expect(html).toContain("<dt>今日涨跌</dt><dd>" + closed + "</dd>");
});

it("keeps the holdings day column and phone line when every closed reading lacks a number", () => {
  positions.splice(0, positions.length, holding);
  const html = render(el(HoldingsWorkspace));
  expect(html).toContain(closed + "</td>");
  expect(html).toContain('class="mx-holding-day">今日 ' + closed + "</small>");
});

it("shows the closure in the drawer’s day move and keeps its unrealized move", () => {
  const earlierReading = { ...holding, dayChangeDate: "2026-11-25", dayChangeGbp: 0, dayChangePct: 0 };
  const html = render(el(HoldingDetail, { holding: earlierReading, account: "Invest", today: day, now: Date.parse(day) }));
  expect(html).toContain("<dt>今日</dt><dd><strong>" + closed + "</strong></dd>");
  expect(html).toContain("33.33%");
});
