"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as el, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/locale-provider";
import { fetchDashboardLens } from "@/lib/dashboard-lenses";
import { ApiError } from "./data";
import { OverviewHoldings } from "./overview-holdings";

afterEach(() => vi.unstubAllGlobals());

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./current-day", () => ({
  useCurrentDay: () => ({ today: "2026-11-26", now: Date.parse("2026-11-26") }),
}));

function render(child: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(el(QueryClientProvider, { client: query }, el(LocaleProvider, { children: child })));
}

describe("OverviewHoldings failure and empty rendering", () => {
  it("renders QueryError with retry instead of the empty state when the dashboard read fails", () => {
    const html = render(
      el(OverviewHoldings, {
        holdings: undefined,
        account: "total",
        failed: true,
        error: new Error("Network error"),
        retry: vi.fn(),
      }),
    );
    expect(html).toContain("持仓");
    expect(html).toContain("暂时无法读取数据");
    expect(html).toContain("重新加载");
    expect(html).toContain('href="/health"');
    expect(html).not.toContain("还没有持仓");
  });

  it("distinguishes timeout errors from a mocked 504 lens response in the holdings query-error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Portfolio backend timed out" }), { status: 504 })),
    );
    let error: unknown;
    try {
      await fetchDashboardLens("overview", undefined, { detail: "summary" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(504);

    const html = render(
      el(OverviewHoldings, {
        holdings: undefined,
        account: "isa",
        failed: true,
        error,
        retry: vi.fn(),
      }),
    );
    expect(html).toContain("数据请求超时");
    expect(html).not.toContain("还没有持仓");
  });

  it("renders the empty state only when the dashboard read succeeded with zero holdings", () => {
    const html = render(el(OverviewHoldings, { holdings: [], account: "isa" }));
    expect(html).toContain("还没有持仓");
    expect(html).not.toContain("暂时无法读取数据");
  });
});
