"use client";

import { researchShellKey } from "@/lib/dashboard-query";
import type {
  ResearchLensSnapshot,
  ResearchShell,
  SecuritySearchResponse,
} from "@/lib/types";
import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Modal,
  Select,
  Stack,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage, useMediaQuery } from "@mantine/hooks";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, isReadTimeout, jsonRequest, object, readApi } from "@/workspace/data";
import {
  Empty,
  LoadingStatus,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Tabs,
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
import { SecurityFinder } from "./research-finder";
import { FundJournal, FundPending, FundWorkbench } from "./research-funds";
import { SecurityActions, SecurityHeader } from "./research-header";
import { resolveResearchIdentity } from "./research-identity";
import { ResearchNotebook } from "./research-notebook";
import { OptionsView } from "./research-options";
import { PricePreview } from "./research-price-preview";
import { basisPrice } from "./research-price-basis";
import { TechnicalWorkspace } from "./research-technical";
import { Seasonality } from "./research-seasonality";
import { UniverseHeading, UniverseList, useResearchUniverse } from "./research-universe";
import { ValuationWorkbench } from "./research-valuation-workbench";
import { researchLensQuery, researchPriceQuery } from "./research-queries";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { previousForIdentity } from "./loading-state";
import { useRetainedResult } from "./retained-result";
import { useRouteState } from "./route-state";

function CitedCalendarEvent({data, kind, date, end}: {data: ResearchLensSnapshot; kind: string; date: string | null; end: string | null}) {
  const t = useCopy();
  const calendar = object(object(data.fundamentals).earningsCalendar);
  const exDividend = kind === "exDividend";
  const raw = exDividend ? calendar["Ex-Dividend Date"] : calendar["Earnings Date"];
  const days = [...new Set((Array.isArray(raw) ? raw : [raw]).flatMap(day =>
    typeof day === "string" && /^\d{4}-\d{2}-\d{2}/.test(day) ? [day.slice(0, 10)] : []))].sort();
  const dates = days.length ? [...new Set([days[0], days[days.length-1]])].join(" – ") : t("暂无可核实日期", "No verified date");
  return <section data-reading-event=""><Panel title={exDividend ? t("除息日期", "Ex-dividend date") : t("预计财报日期", "Estimated earnings date")}>
    <p>{data.ticker} · {dates}</p>
    {days.length > 0 && (date !== days[0] || (end && end !== days.at(-1))) &&
      <p>{t("当前日历已更新。", "The current calendar has changed since this brief.")}</p>}
  </Panel></section>;
}

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

export function ResearchWorkspace() {
  const { params } = useRouteState();
  return params.get("type") === "index" ? <IndexResearchWorkspace /> : <SecurityResearchWorkspace />;
}

function SecurityResearchWorkspace() {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const wide = useMediaQuery("(min-width: 1280px)");
  const [pinned, setPinned] = useLocalStorage({
    key: "mx-research-list-pinned",
    defaultValue: false,
  });
  const [finder, setFinder] = useState(false);
  const [finderQuery, setFinderQuery] = useState("");
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
  const detail = tab === "overview" ? "summary"
    : tab === "technical" ? (!isFund && params.get("technicalView") === "seasonality" ? "seasonality" : "summary")
    : tab === "ledger" ? (!isFund && ["filings", "news"].includes(params.get("notebook") ?? "notes") ? "documents" : "summary")
    : lensName === "fundamentals" && (isFund || params.get("financialMode") !== "full") ? "summary"
    : "full";
  const lens = useQuery({
    ...researchLensQuery(ticker, lensName, revision, detail, readOnly),
    enabled: Boolean(selected),
  });
  const quote = previousForIdentity(lens.data, lens.data?.ticker, ticker) ?? cached;
  // A held line on the quote's listing is quoted at its broker price everywhere on the page.
  const price = basisPrice(selected, quote?.context?.quote);
  // Lenses name the next report by the exchange's date and carry its sessions:
  // a lens left open refetches when that date turns or the sessions run out.
  useLensRefresh(ticker, quote?.context?.quote);
  const prices = useOverviewPrices(ticker, revision ?? "", Boolean(selected) && tab === "overview" && (!isFund || selected?.status !== "pending"));
  const overviewWaiting = tab === "overview" && !isFund && (
    (prices.isPending && !prices.data) || runtime.status === "loading"
  );
  const technicalPrice = tab === "technical" && (isFund || params.get("technicalView") !== "seasonality");
  const currentLens = !overviewWaiting && !awaitingHeldFund && !lens.isPlaceholderData && lens.data ? {
    ticker, tab, data: lens.data, technicalPrice, updatedAt: lens.dataUpdatedAt,
  } : undefined;
  const lastLens = useRetainedResult(currentLens, (a, b) =>
    a.ticker === b.ticker && a.tab === b.tab && a.data === b.data &&
    a.technicalPrice === b.technicalPrice && a.updatedAt === b.updatedAt);

  const shown = previousForIdentity(lastLens, lastLens?.ticker, ticker);
  const displayTab = shown?.tab ?? tab;
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
        event.isComposing ||
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
      onSearch={() => setFinder(true)}
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
    valuation: t("估值模型", "Valuation"),
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
              variant="default"
              rightSection={<CaretDown size={14} />}
              aria-expanded={listOpen}
              onClick={openUniverse}
            >
              {t("研究清单", "Research list")}
            </Button>
          )}
          {selected && (
            <>
              <Tooltip label={<>{t("上一个", "Previous")} <kbd>K</kbd></>}>
                <ActionIcon
                  variant="default"
                  aria-label={t("上一个", "Previous")}
                  aria-keyshortcuts="K"
                  disabled={!previous}
                  onClick={() => previous && selectTicker(previous.ticker)}
                >
                  <CaretLeft size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={<>{t("下一个", "Next")} <kbd>J</kbd></>}>
                <ActionIcon
                  variant="default"
                  aria-label={t("下一个", "Next")}
                  aria-keyshortcuts="J"
                  disabled={!next}
                  onClick={() => next && selectTicker(next.ticker)}
                >
                  <CaretRight size={18} />
                </ActionIcon>
              </Tooltip>
              {!isFund && <ResearchComparison ticker={ticker} instruments={instruments} />}
            </>
          )}
          <Tooltip label={t("搜索", "Search")}>
            <ActionIcon
              variant="default"
              aria-label={t("搜索", "Search")}
              onClick={() => setFinder(true)}
            >
              <MagnifyingGlass size={17} />
            </ActionIcon>
          </Tooltip>
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
                <Stack>
                  {candidates.map((item) => (
                    <Button
                      key={item.ticker}
                      variant="default"
                      h="auto"
                      py="sm"
                      styles={{
                        label: { whiteSpace: "normal", textAlign: "left" },
                      }}
                      onClick={() => update({ ticker: item.ticker })}
                    >
                      {item.ticker} · {item.exchange} · {item.name}
                    </Button>
                  ))}
                </Stack>
              </Panel>
            ) : !selected && security.isFetching ? (
              <Pending shape="research" quiet />
            ) : !selected && security.isError ? (
              <Panel>
                <Empty
                  title={t("暂时无法查找“", "Could not look up “") + ticker + "”"}
                  action={
                    <Group justify="center">
                      <Button onClick={() => void security.refetch()}>{t("重试", "Retry")}</Button>
                      <Button
                        variant="default"
                        leftSection={<MagnifyingGlass size={16} />}
                        onClick={() => {
                          setFinderQuery(ticker);
                          setFinder(true);
                        }}
                      >
                        {t("搜索", "Search")}
                      </Button>
                    </Group>
                  }
                />
              </Panel>
            ) : !selected && !ticker ? (
              <Panel>
                <div className="mx-research-start">
                  <Button leftSection={<MagnifyingGlass size={16} />} onClick={() => setFinder(true)}>
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
                      leftSection={<MagnifyingGlass size={16} />}
                      onClick={() => {
                        // Open the finder already searching for this ticker.
                        setFinderQuery(ticker);
                        setFinder(true);
                      }}
                    >
                      {t("搜索", "Search")}
                    </Button>
                  }
                />
              </Panel>
            ) : (
              <>
                {params.get("fromFund") && (
                  <Button
                    variant="subtle"
                    size="compact-sm"
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
                <Tabs
                  label={t("研究视角", "Research perspectives")}
                  value={tab === "financials" ? "fundamentals" : tab}
                  onChange={(v) => update({ view: v === "overview" ? null : v, fundMode: null })}
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
                {displayTab === "overview" && shown && (!isFund || selected.status !== "pending") && (runtime.status === "failed"
                  ? <QueryError retry={runtime.retry} />
                  : <PricePreview ticker={ticker} query={prices} summary={displayData?.technicalSummary} />
                )}
                {(tab === "technical" || displayTab === "technical") && <>
                          {!isFund && <Tabs
                            label={t(
                              "价格与技术内容",
                              "Price & technical sections",
                            )}
                            value={
                              params.get("technicalView") === "seasonality" ? "seasonality" : "price"
                            }
                            onChange={(v) =>
                              update({
                                technicalView: v === "price" ? null : v,
                              })
                            }
                            options={[
                              { value: "price", label: t("走势与诊断", "Chart & diagnosis") },
                              {
                                value: "seasonality",
                                label: t("季节性", "Seasonality"),
                              },
                            ]}
                          />}
                          {(tab === "technical" ? technicalPrice : shown?.technicalPrice) && (
                            <TechnicalWorkspace
                              key={ticker}
                              ticker={ticker}
                              runId={revision ?? ""}
                              data={displayTab === "technical" ? displayData : undefined}
                              pending={lens.isPending}
                              error={lens.isError}
                              retry={() => { void lens.refetch(); }}
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
                      {displayTab === "overview" && params.get("evidence") === "read_research_lens" &&
                        ["exDividend","earningsWindow"].includes(params.get("event") ?? "") &&
                        <CitedCalendarEvent data={displayData} kind={params.get("event")!} date={params.get("date")} end={params.get("end")} />}
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
                      {displayTab === "technical" && !isFund && !shown?.technicalPrice && <Seasonality data={displayData} revision={revision} />}
                      {displayTab === "valuation" && !isFund && (
                        <ValuationWorkbench data={displayData} revision={revision} price={price} />
                      )}
                      {displayTab === "fundamentals" &&
                        (isFund ? (
                          <FundWorkbench
                            mode="holdings"
                            data={displayData}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench data={displayData} />
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
                            data={displayData}
                            initialMode="income"
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
                        <AnalystView data={displayData} revision={revision} price={price} />
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
        onClose={() => setFinder(false)}
        key={finderQuery}
        initial={finderQuery || (selected ? "" : ticker)}
        onSelect={(result) => {
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
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setRemoveConfirm(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            color="red"
            loading={operation.isPending}
            onClick={() => operation.mutate({ action: "remove" })}
          >
            {t("移除", "Remove")}
          </Button>
        </Group>
      </Modal>
    </Page>
  );
}
