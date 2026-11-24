"use client";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as el, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/locale-provider";
import { ApiError } from "./data";
import { LOCAL_ONBOARDING_QUERY_KEY, type LocalWorkspaceStatus } from "./local-onboarding";
import { OverviewWorkspace } from "./overview";

const { state } = vi.hoisted(() => ({
  state: {
    lens: {
      data: undefined as Record<string, unknown> | undefined,
      isError: true,
      isRefetchError: false,
      error: undefined as unknown,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    },
    history: {
      data: undefined as Record<string, unknown> | undefined,
      isPending: false,
      isError: false,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    },
  },
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/dashboard-lenses", () => ({
  useDashboardLens: () => state.lens,
}));
vi.mock("@/lib/portfolio-history-query", () => ({
  usePortfolioHistory: () => state.history,
}));
vi.mock("@/ui/charts/use-echarts", () => ({
  useChartRuntime: () => ({ status: "ready", retry: vi.fn() }),
}));
vi.mock("@/ui/publication-provider", () => ({
  usePublicationFailure: () => undefined,
  useBuildNavigation: () => undefined,
}));
vi.mock("./route-state", () => ({
  useRouteState: () => ({ params: new URLSearchParams(), update: vi.fn() }),
}));
vi.mock("./profile", () => ({
  useWorkspaceProfile: () => ({ data: undefined }),
  accountName: (_profile: unknown, code: string) => (code === "A" ? "Invest" : "ISA"),
}));
vi.mock("./assistant/context", () => ({
  useAssistantPageContext: vi.fn(),
  useAssistant: () => ({ ready: false }),
}));
vi.mock("./current-day", () => ({
  useCurrentDay: () => ({ today: "2026-11-26", now: Date.parse("2026-11-26") }),
}));
vi.mock("./overview-sectors", () => ({
  OverviewSectors: () => null,
}));
vi.mock("./narrative", () => ({
  Narrative: () => null,
}));
vi.mock("./timeline-chart", () => ({
  TimelineChart: () => null,
}));

function workspaceStatus(overrides: Partial<LocalWorkspaceStatus> = {}): LocalWorkspaceStatus {
  return {
    name: "Local test workspace",
    path: "/tmp/synthetic-workspace",
    connectedAccounts: [],
    readiness: {
      status: "not_ready",
      service: "trading_max-api",
      latestRunId: null,
      bootstrapError: null,
      worker: {
        worker_id: "worker-test",
        status: "idle",
        started_at: null,
        last_seen_at: null,
        current_job_id: null,
        worker_version: "test",
        pid: 1,
        host: "localhost",
        age_seconds: 1,
        healthy: true,
      },
      queue: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        interrupted: 0,
        last_success_at: null,
      },
    },
    latestFullJob: null,
    activeJobId: null,
    canConfirm: false,
    confirmed: false,
    ...overrides,
  };
}

function render(child: ReactNode, setup?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  setup?.(client);
  return renderToStaticMarkup(
    el(
      MantineProvider,
      {},
      el(QueryClientProvider, { client }, el(LocaleProvider, { children: child })),
    ),
  );
}

async function renderAsync(child: ReactNode, setup: (client: QueryClient) => Promise<void>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  await setup(client);
  return renderToStaticMarkup(
    el(
      MantineProvider,
      {},
      el(QueryClientProvider, { client }, el(LocaleProvider, { children: child })),
    ),
  );
}

beforeEach(() => {
  state.lens = {
    data: undefined,
    isError: true,
    isRefetchError: false,
    error: new ApiError("Internal Server Error", 500),
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  };
  state.history = {
    data: undefined,
    isPending: false,
    isError: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  };
});

describe("OverviewWorkspace error, freshness, and local onboarding states", () => {
  it("routes confirmed local workspaces to the overview error UI on transient failures without rendering stale Freshness", () => {
    const html = render(el(OverviewWorkspace, { localWorkspace: true }), (client) => {
      client.setQueryData(
        LOCAL_ONBOARDING_QUERY_KEY,
        workspaceStatus({ connectedAccounts: ["invest"], confirmed: true }),
      );
    });
    expect(html).toContain("账户价值暂不可用");
    expect(html).toContain("盈亏记录暂不可用");
    expect(html).toContain("暂时无法读取数据");
    expect(html).toContain("重新加载");
    expect(html).not.toContain("开始使用你的本地工作区");
    expect(html).not.toContain("数据截至");
    expect(html).not.toContain("尚未更新");
    expect(html).not.toContain("还没有持仓");
  });

  it("shows first-run onboarding for a truly new empty unconfirmed local workspace", () => {
    const html = render(el(OverviewWorkspace, { localWorkspace: true }), (client) => {
      client.setQueryData(LOCAL_ONBOARDING_QUERY_KEY, workspaceStatus({ confirmed: false }));
    });
    expect(html).toContain("开始使用你的本地工作区");
    expect(html).toContain('href="/settings?tab=accounts&amp;onboarding=1"');
    expect(html).not.toContain("账户价值暂不可用");
  });

  it("falls through to the overview error UI when local workspace status itself fails", async () => {
    const html = await renderAsync(el(OverviewWorkspace, { localWorkspace: true }), async (client) => {
      await client.prefetchQuery({
        queryKey: LOCAL_ONBOARDING_QUERY_KEY,
        queryFn: () => Promise.reject(new ApiError("Unavailable", 503)),
        retry: false,
      });
    });
    expect(html).toContain("账户价值暂不可用");
    expect(html).toContain("暂时无法读取数据");
    expect(html).not.toContain("开始使用你的本地工作区");
    expect(html).not.toContain("数据截至");
  });

  it("stays in the waiting skeleton while local onboarding status is still loading", () => {
    const html = render(el(OverviewWorkspace, { localWorkspace: true }));
    expect(html).toContain("mx-loading-summary");
    expect(html).toContain("mx-loading-holdings");
    expect(html).not.toContain("账户价值暂不可用");
    expect(html).not.toContain("数据截至");
    expect(html).not.toContain("尚未更新");
  });

  it("hides Freshness and shows timeout holdings error on initial 504 failure", () => {
    state.lens.error = new ApiError("dashboard lens returned 504", 504);
    const html = render(el(OverviewWorkspace, { localWorkspace: false }));
    expect(html).toContain("账户价值暂不可用");
    expect(html).toContain("重试");
    expect(html).toContain("数据请求超时");
    expect(html).not.toContain("数据截至");
    expect(html).not.toContain("尚未更新");
    expect(html).not.toContain("还没有持仓");
  });

  it("keeps Freshness visible on a refetch failure when retained data is present", () => {
    const updatedAt = Date.parse("2026-11-26T10:00:00Z");
    state.lens = {
      data: {
        runId: "run-1",
        brokerAsOf: "2026-11-26T10:00:00Z",
        totalValueGbp: 1000,
        totalUnrealizedPnlGbp: 50,
        totalCashGbp: 200,
        accounts: [{ code: "A", isInvestable: true, totalValueGbp: 1000, unrealizedPnlGbp: 50, cashGbp: 200 }],
        holdings: [],
      },
      isError: true,
      isRefetchError: true,
      error: new ApiError("Unavailable", 503),
      dataUpdatedAt: updatedAt,
      refetch: vi.fn(),
    };
    state.history = {
      data: {
        history: { points: [], timeline: [], source: "daily", endDay: "2026-11-26", pendingCashFlows: false },
        money: { pnl: 0, pnls: [], pnlPercents: [] },
        openings: [],
      },
      isPending: false,
      isError: false,
      dataUpdatedAt: updatedAt,
      refetch: vi.fn(),
    };
    const html = render(el(OverviewWorkspace, { localWorkspace: false }));
    expect(html).toContain("数据截至");
    expect(html).toContain("更新失败");
    expect(html).not.toContain("账户价值暂不可用");
  });
});
