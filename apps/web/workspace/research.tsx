"use client";
import dynamic from "next/dynamic";
import { useEarningsBrief, PositionReading } from "./assistant/research-entry";
import { useAssistantPageContext } from "./assistant/context";

import { citedEventKind } from "@/lib/cited-calendar-event";
import { researchShellKey } from "@/lib/dashboard-query";
import type {
  ResearchLensSnapshot,
  ResearchShell,
  SecuritySearchResponse,
} from "@/lib/types";
import {
  Drawer,
  Modal,
  Select,
  Tooltip,
} from "@mantine/core";
import { Button } from "@/components/ui/button";
import { useBreakpoint, useLocalStorage } from "@/lib/hooks";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isImeComposing } from "./shortcut-platform";
import { api, isReadTimeout, jsonRequest, readApi } from "@/workspace/data";
import {
  Empty,
  LoadingStatus,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  TabPanel,
  Tabs,
  TabsScope,
  useCopy,
} from "./foundation";
import {
  AnalystView,
  CompanyOverview,
} from "./research-company";
import { ResearchComparison } from "./research-compare";
import { useLensRefresh } from "./research-clock";
import { FinancialWorkbench } from "./research-financials";
import { IndexResearchWorkspace } from "./research-index";
import { SecurityFinder, useSearchHandover } from "./research-finder";
import { FundJournal, FundPending, FundWorkbench } from "./research-funds";
import { SecurityActions, SecurityHeader } from "./research-header";
import { resolveResearchIdentity } from "./research-identity";
import { ResearchNotebook } from "./research-notebook";
import { OptionsView } from "./research-options";
import { PricePreview } from "./research-price-preview";
import { basisPrice, lensFallback } from "./research-price-basis";
import { SeasonalitySection, TechnicalWorkspace } from "./research-technical";
import { UniverseHeading, UniverseList, useResearchUniverse } from "./research-universe";
import { ValuationWorkbench } from "./research-valuation-workbench";
import { researchLensQuery, researchPriceQuery } from "./research-queries";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { previousForIdentity } from "./loading-state";
import { useRetainedResult } from "./retained-result";
import { useRouteState } from "./route-state";

import { CitedResearchEvent } from "./research-cited-event";

export type ResearchTab =
  | "overview"
  | "technical"
  | "valuation"
  | "fundamentals"
  | "financials"
  | "analyst"
  | "options"
  | "tracking"
  | "peers"
  | "ledger";
const researchTabs: ResearchTab[] = [
  "overview",
  "technical",
  "valuation",
  "fundamentals",
  "financials",
  "analyst",
  "options",
  "tracking",
  "peers",
  "ledger",
];

export function fundResearchTab(tab: ResearchTab, fundMode: string | null): ResearchTab {
  if (["analyst", "valuation"].includes(tab)) return "overview";
  if (fundMode === "tracking" && ["fundamentals", "financials", "overview"].includes(tab)) return "tracking";
  return tab === "financials" ? "fundamentals" : tab;
}
export function useOverviewPrices(ticker: string, revision: string, enabled: boolean) {
  return useQuery({ ...researchPriceQuery(ticker, revision, "1d", "3M"), enabled });
}

const CitedResearch = dynamic(() => import("./assistant/cited-research"));

export function ResearchWorkspace() {
  const { params } = useRouteState();
  const reviewEvent = ["decision_timing_and_habits","news_and_events"].includes(params.get("evidence") ?? "") &&
    ["events","actions","ratings"].includes(params.get("analystView") ?? "");
  if (reviewEvent) return <CitedResearchEvent recorded />;
  if (["read_research_lens", "upcoming_events", "news_and_events"].includes(params.get("evidence") ?? "") && citedEventKind(params.get("event"))) {
    return <CitedResearchEvent />;
  }
  if ((params.has("snapshotId") || params.has("unavailable")) && params.has("evidenceId")) return <CitedResearch/>;
  return params.get("type") === "index" ? <IndexResearchWorkspace /> : <SecurityResearchWorkspace />;
}

function SecurityResearchWorkspace() {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const wide = useBreakpoint("wide");
  const [pinned, setPinned] = useLocalStorage({
    key: "mx-research-list-pinned",
    defaultValue: false,
  });
  const [finder, setFinder] = useState(false);
  const [finderQuery, setFinderQuery] = useState("");
  // Search hands over a security that is not in the research list.
  const handover = useSearchHandover((text) => {
    setFinderQuery(text);
    setFinder(true);
  });
  const [universeOpen, setUniverseOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const client = useQueryClient();
  const runtime = useChartRuntime("research");
  const shell = useQuery({
    queryKey: researchShellKey,
    queryFn: ({ signal }) => readApi<ResearchShell>("/research/shell", signal),
    retry: (count, error) => count < 1 && !isReadTimeout(error),
    refetchInterval: (q) =>
      q.state.data?.instruments.some(
        (i) => i.status === "pending" || i.status === "running",
      )
        ? 2000
        : false,
  });
  const instruments = shell.data?.instruments ?? [];
  const universeState = useResearchUniverse(instruments);
  const { displayed } = universeState;
  const requestedTicker = params.get("ticker");
  const firstTicker = instruments.find((i) => i.held)?.ticker ?? instruments[0]?.ticker ?? "";
  const [defaultTicker, setDefaultTicker] = useState("");
  if (!defaultTicker && firstTicker) setDefaultTicker(firstTicker);
  const requested = requestedTicker?.trim() || defaultTicker || firstTicker;
  const { selected: listed, candidates } = resolveResearchIdentity(instruments, requested);
  const previewTicker = (listed?.ticker ?? requested).toUpperCase();
  const previewOnly = !listed || (listed.watchlisted === false && !listed.held);
  const previewKey = (symbol: string) => ["research-preview-security", symbol];
  const security = useQuery({
    queryKey: previewKey(previewTicker),
    enabled: Boolean(shell.data && previewOnly && candidates.length === 0 && previewTicker.length >= 2),
    queryFn: async ({ signal }) => (await api<SecuritySearchResponse>(
      "/securities/search?q=" + encodeURIComponent(previewTicker), { signal },
    )).results.find((row) => row.ticker === previewTicker) ?? null,
    staleTime: 60_000,
    retry: false,
  });
  const selected = listed ?? (previewOnly && security.data ? {
    ticker: security.data.ticker,
    name: security.data.name,
    exchange: security.data.exchange,
    watchlisted: false,
    isFund: ["ETF", "ETP", "MUTUALFUND"].includes(security.data.securityType?.toUpperCase() ?? ""),
    held: false,
    status: "partial" as const,
    lastRunId: null,
    watchlistTicker: null,
    categoryId: "",
    directValueGbp: 0,
    exposureGbp: 0,
    gics: null,
  } : undefined);
  const ticker = selected?.ticker ?? requested;
  const readOnly = Boolean(selected && selected.watchlisted === false && !selected.held);
  useEffect(() => {
    if (ticker && requestedTicker && requestedTicker !== ticker) {
      update({ ticker });
    }
  }, [ticker, requestedTicker, update]);
  const requestedTab: ResearchTab = researchTabs.includes(params.get("view") as ResearchTab)
    ? params.get("view") as ResearchTab : "overview";
  const cached = client.getQueriesData<ResearchLensSnapshot>({ queryKey: ["workspace-research", ticker] })
    .map(([key, data]) => ({ data, updatedAt: client.getQueryState(key)?.dataUpdatedAt ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find(({ data }) => data?.ticker === ticker)?.data;
  const isFund = Boolean(selected?.isFund || ["ETF", "MUTUALFUND"].includes(cached?.context?.assetType ?? ""));
  const tab = readOnly && !(isFund ? ["overview", "technical", "tracking", "peers"] : ["overview", "technical"]).includes(requestedTab)
    ? "overview"
    : isFund ? fundResearchTab(requestedTab, params.get("fundMode"))
    : ["tracking", "peers"].includes(requestedTab) ? "overview" : requestedTab;
  const fetching = selected?.status === "pending" || selected?.status === "running";
  const awaitingHeldFund = Boolean(isFund && selected?.held && fetching && ["overview", "tracking", "fundamentals", "peers"].includes(tab));

  const lensName = ["financials", "tracking", "peers"].includes(tab) ? "fundamentals" : tab;
  const revision = selected?.lastRunId ?? shell.data?.status.runId;
  // Seasonality and the complete statements load in their own sections.
  const detail = tab === "overview" || tab === "technical" ? "summary"
    : tab === "ledger" ? (!isFund && ["filings", "news"].includes(params.get("notebook") ?? "notes") ? "documents" : "summary")
    : lensName === "fundamentals" ? "summary"
    : "full";
  const lens = useQuery({
    ...researchLensQuery(ticker, lensName, revision, detail, readOnly),
    enabled: Boolean(selected),
  });
  const quote = previousForIdentity(lens.data, lens.data?.ticker, ticker) ?? cached;
  // A held line on the quote's listing is quoted at its broker price everywhere on the page.
  const price = basisPrice(selected, quote?.context?.quote, lensFallback(quote));
  // Lenses name the next report by the exchange's date and carry its sessions:
  // a lens left open refetches when that date turns or the sessions run out.
  useLensRefresh(ticker, quote?.context?.quote);
  const prices = useOverviewPrices(ticker, revision ?? "", Boolean(selected) && tab === "overview" && (!isFund || selected?.status !== "pending"));
  const overviewWaiting = tab === "overview" && !isFund && (
    (prices.isPending && !prices.data) || runtime.status === "loading"
  );
  const technicalPrice = tab === "technical";
  const earnings = useEarningsBrief(ticker, lensName, lens.data?.runId ?? revision ?? undefined, Boolean(selected && !isFund && (lensName === "analyst" || lensName === "fundamentals")), lens.isPlaceholderData ? undefined : lens.data);
  const currentLens = !overviewWaiting && !awaitingHeldFund && !lens.isPlaceholderData && lens.data ? {
    ticker, tab, data: lens.data, technicalPrice, updatedAt: lens.dataUpdatedAt,
  } : undefined;
  const lastLens = useRetainedResult(currentLens, (a, b) =>
    a.ticker === b.ticker && a.tab === b.tab && a.data === b.data &&
    a.technicalPrice === b.technicalPrice && a.updatedAt === b.updatedAt);

  const shown = previousForIdentity(lastLens, lastLens?.ticker, ticker);
  const displayTab = shown?.tab ?? tab;
  const assistantLens = tab === "technical" ? "technical"
    : displayTab === "financials" ? "fundamentals" : displayTab;
  useAssistantPageContext({
    page: "research",
    ticker: selected ? ticker : undefined,
    lens: selected ? assistantLens : undefined,
    snapshotId: tab === "technical" && displayTab !== "technical" ? undefined : shown?.data.runId,
  });
  const displayData = shown?.data;
  const switching = Boolean(shown && (!currentLens || lens.isPlaceholderData) && !lens.isError);
  const failure = lens.isError ? lens : shell.isRefetchError ? shell : null;
  const publicationFailure = usePublicationFailure(shown?.updatedAt ?? 0);
  const waitingForResearch = !shown && !technicalPrice && !awaitingHeldFund && (
    !lens.isError && (overviewWaiting || lens.isPending || fetching)
  );
  const exploreHolding = (symbol: string) => {
    const target = instruments.find((i) => i.ticker === symbol);
    if (target) update({ ticker: target.ticker, view: null, fromFund: ticker });
    else {
      setFinderQuery(symbol);
      setFinder(true);
    }
  };
  const operation = useMutation({
    mutationFn: ({
      action,
      categoryId,
    }: {
      action: "refresh" | "remove" | "move" | "add";
      categoryId?: string;
    }) =>
      action === "add" && security.data
      ? api("/watchlist", jsonRequest("POST", { security: security.data, refresh: true }))
      : action === "refresh" && isFund && (selected?.held || selected?.watchlisted === false)
      ? api("/refresh", jsonRequest("POST", { scope: "research", skipSync: true, tickers: [ticker] }))
      : api(
        "/watchlist/" + encodeURIComponent(selected?.watchlistTicker ?? ticker),
        jsonRequest("POST", { action, categoryId }),
      ),
    onSuccess: async (_, variables) => {
      if (variables.action === "remove") {
        const rest = instruments.filter((item) => item.ticker !== ticker);
        setDefaultTicker(rest.find((item) => item.held)?.ticker ?? rest[0]?.ticker ?? "");
        update({ ticker: null });
        setRemoveConfirm(false);
      }
      setManage(false);
      await client.invalidateQueries({
        queryKey: ["workspace-research-shell"],
      });
      await client.invalidateQueries({ queryKey: ["workspace-research", ticker] });
      if (variables.action === "refresh")
        await client.invalidateQueries({ queryKey: ["workspace-prices", ticker] });
    },
  });
  function selectTicker(value: string) {
    update({ ticker: value });
    setUniverseOpen(false);
  }
  // A pinned list is already on screen: switching means searching it.
  const listOpen = universeOpen || (wide && pinned);
  function openUniverse() {
    if (wide && pinned)
      document
        .querySelector<HTMLInputElement>(".mx-research-universe input")
        ?.focus();
    else setUniverseOpen(true);
  }
  const position = displayed.findIndex((i) => i.ticker === ticker);
  const previous = position > 0 ? displayed[position - 1] : undefined;
  const next = position >= 0 ? displayed[position + 1] : undefined;
  // J and K step through the visible research list, like the arrow buttons.
  useEffect(() => {
    function step(event: KeyboardEvent) {
      // Plain J/K only: no modifiers, no IME composition, nothing already handled.
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        isImeComposing(event) ||
        event.defaultPrevented
      )
        return;
      const key = event.key.toLowerCase();
      const target = key === "j" ? next : key === "k" ? previous : undefined;
      const origin = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        origin?.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=combobox], [role=listbox], [role=menu]",
        )
      )
        return;
      event.preventDefault();
      update({ ticker: target.ticker });
      setUniverseOpen(false);
    }
    window.addEventListener("keydown", step);
    return () => window.removeEventListener("keydown", step);
  }, [next, previous, update]);
  const universeHeading = (
    <UniverseHeading
      wide={wide}
      pinned={pinned}
      onPin={() => {
        setPinned(!pinned);
        setUniverseOpen(pinned);
      }}
      onSearch={() => {
        setFinderQuery("");
        setFinder(true);
      }}
    />
  );
  const universe = (
    <UniverseList
      state={universeState}
      categories={shell.data?.watchlistCategories ?? []}
      instruments={instruments}
      ticker={ticker}
      onSelect={selectTicker}
    />
  );
  const titles: Record<ResearchTab, string> = {
    overview: t("概览", "Overview"),
    technical: t("价格与技术", "Price & technicals"),
    valuation: t("估值", "Valuation"),
    fundamentals: t("财务与业务", "Financials & business"),
    financials: t("财务报表", "Financials"),
    analyst: t("预期与事件", "Estimates & events"),
    options: t("期权结构", "Options"),
    tracking: t("指数与跟踪", "Index & tracking"),
    peers: t("同类", "Peers"),
    ledger: t("研究记录", "Journal"),
  };
  // Phone labels keep all seven lenses in view; each is part of its full title.
  const shortTitles: Record<ResearchTab, string> = {
    overview: t("概览", "Overview"),
    technical: t("价格", "Price"),
    valuation: t("估值", "Valuation"),
    fundamentals: t("财务", "Financials"),
    financials: t("财务", "Financials"),
    analyst: t("预期", "Estimates"),
    options: t("期权", "Options"),
    tracking: t("指数", "Index"),
    peers: t("同类", "Peers"),
    ledger: t("记录", "Journal"),
  };
  return (
    <Page
      className="mx-research-page"
      title={t("研究", "Research")}
      titleHidden
      actions={
        <>
          {/* With a stock or fund open, its name in the header is the switcher. */}
          {!selected && (
            <Button
              className="mx-universe-toggle"
              variant="secondary"
              aria-expanded={listOpen}
              onClick={openUniverse}
            >
              {t("研究清单", "Research list")}
              <ChevronDown size={16} aria-hidden="true" />
            </Button>
          )}
          {selected && (
            <>
              <Tooltip label={<>{t("上一个", "Previous")} <kbd>K</kbd></>}>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("上一个", "Previous")}
                  aria-keyshortcuts="K"
                  disabled={!previous}
                  onClick={() => previous && selectTicker(previous.ticker)}
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip label={<>{t("下一个", "Next")} <kbd>J</kbd></>}>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("下一个", "Next")}
                  aria-keyshortcuts="J"
                  disabled={!next}
                  onClick={() => next && selectTicker(next.ticker)}
                >
                  <ChevronRight size={18} aria-hidden="true" />
                </Button>
              </Tooltip>
              {!isFund && <ResearchComparison ticker={ticker} instruments={instruments} />}
            </>
          )}
          {selected && (
            <SecurityActions
              held={selected.held}
              categoriesAvailable={Boolean(shell.data?.watchlistCategories.length)}
              watchlisted={selected.watchlisted !== false}
              busy={operation.isPending || fetching && !awaitingHeldFund}
              pending={operation.isPending}
              onRefresh={() => operation.mutate({ action: "refresh" })}
              onAdd={readOnly ? () => { if (security.data) operation.mutate({ action: "add" }); } : undefined}
              addDisabled={readOnly && !security.data}
              onManage={() => setManage(true)}
              onRemove={() => setRemoveConfirm(true)}
            />
          )}
        </>
      }
    >
      {(shell.isPending || Boolean(selected && waitingForResearch)) &&
        <LoadingStatus label={t("正在读取研究…", "Loading research…")} />}
      {!shell.data ? (
        <>
          {ticker && <section className="mx-panel"><h2>{ticker}</h2></section>}
          {shell.isPending ? <Pending shape="research" quiet />
            : <QueryError retry={shell.refetch} error={shell.error} />}
        </>
      ) : (
        <div
          className="mx-research-layout"
          data-pinned={(pinned && wide) || undefined}
        >
          {pinned && wide && (
            <aside
              className="mx-research-universe"
              aria-label={t("研究清单", "Research list")}
            >
              <h2>{universeHeading}</h2>
              {universe}
            </aside>
          )}
          <div className="mx-research-content">
            {candidates.length ? (
              <Panel title={t("选择上市地", "Choose a listing")}>
                <div className="flex flex-col gap-mx-md">
                  {candidates.map((item) => (
                    <Button
                      key={item.ticker}
                      variant="secondary"
                      className="h-auto justify-start py-2.5 text-left whitespace-normal"
                      onClick={() => update({ ticker: item.ticker })}
                    >
                      {item.ticker} · {item.exchange} · {item.name}
                    </Button>
                  ))}
                </div>
              </Panel>
            ) : !selected && security.isFetching ? (
              <Pending shape="research" quiet />
            ) : !selected && security.isError ? (
              <Panel>
                <Empty
                  title={t("暂时无法查找“", "Could not look up “") + ticker + "”"}
                  action={
                    <div className="flex flex-wrap items-center justify-center gap-mx-md">
                      <Button onClick={() => void security.refetch()}>{t("重试", "Retry")}</Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setFinderQuery(ticker);
                          setFinder(true);
                        }}
                      >
                        <Search size={16} aria-hidden="true" />
                        {t("搜索", "Search")}
                      </Button>
                    </div>
                  }
                />
              </Panel>
            ) : !selected && !ticker ? (
              <Panel>
                <div className="mx-research-start">
                  <Button onClick={() => setFinder(true)}>
                    <Search size={16} aria-hidden="true" />
                    {t("搜索", "Search")}
                  </Button>
                </div>
              </Panel>
            ) : !selected ? (
              <Panel>
                <Empty
                  title={t("没有找到“", "No results for “") + ticker + "”"}
                  action={
                    <Button
                      onClick={() => {
                        // Open the finder already searching for this ticker.
                        setFinderQuery(ticker);
                        setFinder(true);
                      }}
                    >
                      <Search size={16} aria-hidden="true" />
                      {t("搜索", "Search")}
                    </Button>
                  }
                />
              </Panel>
            ) : (
              <>
                {params.get("fromFund") && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      update({
                        ticker: params.get("fromFund"),
                        view: "fundamentals",
                        fromFund: null,
                      })
                    }
                  >
                    {t("返回基金持仓", "Back to fund holdings")} ·{" "}
                    {params.get("fromFund")}
                  </Button>
                )}
                <SecurityHeader
                  ticker={ticker}
                  selected={selected}
                  quote={quote}
                  quotePending={!quote && lens.isPending}
                  failure={failure && (failure.dataUpdatedAt || shown?.updatedAt) ? {
                    updatedAt: failure.dataUpdatedAt || shown!.updatedAt,
                    retry: failure.refetch,
                  } : publicationFailure}
                  listOpen={listOpen}
                  onSwitch={openUniverse}
                />
                <TabsScope value={tab === "financials" ? "fundamentals" : tab} onChange={(v) => update({
                    view: v === "overview" ? null : v,
                    fundMode: null, analystView: v === "analyst" ? "ratings" : null, valuationView: null, estimateRef: null,
                    technicalView: null, financialMode: null,
                  }, { focusResearchSection: false })}>
                <Tabs
                  label={t("研究视角", "Research perspectives")}
                  value={tab === "financials" ? "fundamentals" : tab}

                  options={(readOnly
                    ? (isFund ? ["overview", "technical", "tracking", "peers"] : ["overview", "technical"]) as ResearchTab[]
                    : isFund
                    ? ["overview", "fundamentals", "technical", "tracking", "peers", "options", "ledger"] as ResearchTab[]
                    : ["overview", "fundamentals", "technical", "analyst", "valuation", "options", "ledger"] as ResearchTab[]
                  ).map((value) => ({
                    value,
                    label: isFund && value === "fundamentals" ? t("持仓与重叠", "Holdings & overlap")
                      : titles[value],
                    short: isFund && value === "fundamentals" ? t("持仓", "Holdings")
                      : shortTitles[value],
                  }))}
                />
                <TabPanel value={tab === "financials" ? "fundamentals" : tab} className="mx-research-lens">
                {failure && shown && isReadTimeout(failure.error) && <Notice tone="warn">
                  {t("研究请求超时，仍显示上一次资料。", "Research request timed out. Showing the previous reading.")}
                </Notice>}
                {operation.isError && (
                  <Notice tone="bad">
                    {t("操作未完成：", "The action did not complete: ")}
                    {operation.error.message}
                  </Notice>
                )}
                {awaitingHeldFund && !shown && !technicalPrice && tab !== "options" && tab !== "ledger" ? (
                  <FundPending ticker={ticker} runId={revision ?? undefined} />
                ) : waitingForResearch ? (
                  tab === "overview" && prices.data && runtime.status === "ready"
                    ? <PricePreview ticker={ticker} query={prices} pending />
                    : <Panel className="mx-research-wait"><Pending shape="chart" height={338} quiet /></Panel>
                ) : (
                <div className="mx-data-body mx-research-read" aria-busy={switching || undefined}>
                {tab === "overview" && displayTab === tab && !prices.isPlaceholderData && (prices.data?.publishedSeriesId || prices.data?.observedSeriesId) && <PositionReading
                  security={{ticker: prices.data.ticker, published_series_id: (prices.data.publishedSeriesId || prices.data.observedSeriesId)!}} snapshotId={prices.data.snapshotId ?? shell.data?.status.runId ?? undefined} />}
                {displayTab === "overview" && shown && (!isFund || selected.status !== "pending") && (runtime.status === "failed"
                  ? <QueryError retry={runtime.retry} />
                  : <PricePreview ticker={ticker} query={prices} summary={displayData?.technicalSummary} />
                )}
                {(tab === "technical" || displayTab === "technical") && <>
                          {(tab === "technical" ? technicalPrice : shown?.technicalPrice) && (
                            <TechnicalWorkspace
                              key={ticker}
                              ticker={ticker}
                              runId={revision ?? ""}
                              snapshotId={shell.data?.status.runId ?? undefined}
                              data={displayTab === "technical" ? displayData : undefined}
                              pending={lens.isPending}
                              error={lens.isError}
                              retry={() => { void lens.refetch(); }}
                              seasonality={isFund ? undefined : <SeasonalitySection ticker={ticker} revision={revision} preview={readOnly} />}
                            />
                          )}
                </>}
                {displayTab === "technical" && (shown?.technicalPrice ?? technicalPrice) ? null : selected.status === "failed" && !displayData ? (
                  <Panel>
                    <Empty
                      title={t(
                        "这次研究更新没有完成",
                        "This research update did not complete",
                      )}
                      description={t(
                        "检查数据状态或重试更新。",
                        "Check data status or retry the update.",
                      )}
                      action={
                        <Button
                          onClick={() =>
                            operation.mutate({ action: "refresh" })
                          }
                        >
                          {t("重新更新", "Retry update")}
                        </Button>
                      }
                    />
                  </Panel>
                ) : lens.isError && !displayData ? (
                  <QueryError retry={lens.refetch} error={lens.error} />
                ) : (
                  displayData && (
                    <>
                      {displayTab === "overview" && (
                        <>
                          {isFund ? (
                            <FundWorkbench
                              mode="overview"
                              data={displayData}
                              onExplore={exploreHolding}
                            />
                          ) : (
                            <CompanyOverview
                              data={displayData}
                              gics={selected.gics}
                            />
                          )}
                        </>
                      )}
                      {displayTab === "valuation" && !isFund && (
                        <ValuationWorkbench key={displayData.ticker} publication={shell.data?.status.runId} data={displayData} revision={revision} price={price} />
                      )}
                      {displayTab === "fundamentals" &&
                        (isFund ? (
                          <FundWorkbench
                            mode="holdings"
                            data={displayData}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench key={ticker} data={displayData} ticker={ticker} revision={revision} preview={readOnly}
                            earningsBrief={tab === displayTab ? earnings : null} />
                        ))}
                      {displayTab === "financials" &&
                        (isFund ? (
                          <FundWorkbench
                            mode="holdings"
                            data={displayData}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench
                            key={ticker}
                            data={displayData}
                            initialMode="income"
                            ticker={ticker}
                            revision={revision}
                            preview={readOnly}
                            earningsBrief={tab === displayTab ? earnings : null}
                          />
                        ))}
                      {isFund && (displayTab === "tracking" || displayTab === "peers") && (
                        <FundWorkbench
                          mode={displayTab}
                          data={displayData}
                          onExplore={exploreHolding}
                          usPeers={instruments.find((item) => item.ticker === displayData.ticker)?.usFundPeers}
                        />
                      )}
                      {displayTab === "analyst" && !isFund && (
                        <AnalystView earningsBrief={tab === "analyst" ? earnings : null} key={ticker} data={displayData} revision={revision} price={price} />
                      )}
                      {displayTab === "options" && <OptionsView key={displayData.ticker} data={displayData} />}
                      {displayTab === "ledger" && (
                        <>
                          <ResearchNotebook key={ticker} data={displayData} fund={isFund} />
                          {isFund && <FundJournal data={displayData} />}
                        </>
                      )}
                    </>
                  )
                )}
                </div>
                )}
                </TabPanel>
                </TabsScope>
              </>
            )}
          </div>
        </div>
      )}
      <Drawer
        opened={universeOpen}
        onClose={() => setUniverseOpen(false)}
        title={universeHeading}
        styles={{ title: { flex: 1 }, header: { gap: 8 } }}
        size={360}
      >
        {universe}
      </Drawer>
      <SecurityFinder
        opened={finder}
        onClose={() => {
          setFinder(false);
          handover.closed();
        }}
        key={finderQuery}
        initial={finderQuery || (selected ? "" : ticker)}
        onSelect={(result) => {
          handover.chosen();
          client.setQueryData(previewKey(result.ticker), result);
          update({ ticker: result.ticker, view: null, fromFund: isFund ? ticker : null });
          setFinder(false);
          setFinderQuery("");
        }}
      />
      <Modal
        opened={manage}
        onClose={() => setManage(false)}
        title={t("研究分类", "Research category")}
      >
        <Select
          disabled={operation.isPending}
          label={t("选择分类", "Choose category")}
          value={selected?.categoryId}
          data={(shell.data?.watchlistCategories ?? []).map((c) => ({
            value: c.id,
            label: t(c.labelZh, c.labelEn),
          }))}
          onChange={(v) =>
            v && operation.mutate({ action: "move", categoryId: v })
          }
        />
      </Modal>
      <Modal
        opened={removeConfirm}
        onClose={() => setRemoveConfirm(false)}
        title={t("从研究清单移除 ", "Remove ") + ticker + t("？", " from the research list?")}
      >
        <div className="flex flex-wrap items-center justify-end gap-mx-md">
          <Button variant="secondary" onClick={() => setRemoveConfirm(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={operation.isPending}
            loadingLabel={t("移除中…", "Removing…")}
            onClick={() => operation.mutate({ action: "remove" })}
          >
            {t("移除", "Remove")}
          </Button>
        </div>
      </Modal>
    </Page>
  );
}
