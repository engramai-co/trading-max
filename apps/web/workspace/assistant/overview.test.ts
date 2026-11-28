"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as el, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/locale-provider";
import type { Reading } from "./evidence";
import { OverviewBrief } from "./overview";

const { state } = vi.hoisted(() => ({
  state: { reading: undefined as Reading | undefined },
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./context", () => ({
  useAssistant: () => ({ ready: true, open: false, close: vi.fn(), continueInSidebar: vi.fn() }),
  usePageRole: vi.fn(),
}));
vi.mock("./reading", () => ({
  fetchReading: vi.fn(),
  useRoleReading: () => ({ data: state.reading, isError: false }),
}));

function render(child: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(el(QueryClientProvider, { client: query }, el(LocaleProvider, { children: child })));
}

const sampleReading: Reading = {
  role: "daily",
  version: "run-1",
  snapshotId: "run-1",
  asOf: "2026-01-30T20:00:00Z",
  lines: [
    {
      section: "portfolio",
      zh: "本期净盈亏 −£10,408.59。",
      en: "Period net P&L was -£10,408.59.",
      evidence: {
        source: "account",
        tool: "period_performance",
        evidenceId: "ev_1",
        arguments: { scope: "broker_total", range: "1D" },
      },
      related: [],
      variants: {},
    },
  ],
};

describe("OverviewBrief header scope", () => {
  it("labels All investment accounts alongside the timestamp when an individual account is selected", () => {
    state.reading = sampleReading;
    const isaHtml = render(el(OverviewBrief, { snapshot: "run-1", scope: "isa" }));
    expect(isaHtml).toContain("全部投资账户 · 截至 ");
    const investHtml = render(el(OverviewBrief, { snapshot: "run-1", scope: "invest" }));
    expect(investHtml).toContain("全部投资账户 · 截至 ");
  });

  it("keeps the timestamp-only header when all investment accounts are selected", () => {
    state.reading = sampleReading;
    const totalHtml = render(el(OverviewBrief, { snapshot: "run-1", scope: "total" }));
    expect(totalHtml).toContain("<span>截至 ");
    expect(totalHtml).not.toContain("全部投资账户 · ");
  });

  it("shows the all-accounts label when no brief reading has loaded yet", () => {
    state.reading = undefined;
    const html = render(el(OverviewBrief, { snapshot: "run-1", scope: "isa" }));
    expect(html).toContain("<span>全部投资账户</span>");
  });
});
