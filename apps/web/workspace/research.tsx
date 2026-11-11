"use client";

import type {
  ResearchLensSnapshot,
  ResearchShell,
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
  Plus,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, jsonRequest } from "@/workspace/data";
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
import { SecurityFinder } from "./research-finder";
import { fundQuery, FundWorkbench } from "./research-funds";
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
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { previousForIdentity } from "./loading-state";
import { useRetainedResult } from "./retained-result";
import { useRouteState } from "./route-state";

export type ResearchTab =
  | "overview"
  | "technical"
  | "valuation"
  | "fundamentals"
  | "financials"
  | "analyst"
  | "options"
  | "ledger";
const researchTabs: ResearchTab[] = [
  "overview",
  "technical",
  "valuation",
  "fundamentals",
  "financials",
  "analyst",
  "options",
  "ledger",
];
export function useOverviewPrices(ticker: string, revision: string, enabled: boolean) {
  return useQuery({ ...researchPriceQuery(ticker, revision, "1d", "3M"), enabled });
}

export function ResearchWorkspace() {
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
    queryKey: ["workspace-research-shell"],
    queryFn: ({ signal }) => api<ResearchShell>("/research/shell", { signal }),
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
  const requested =
    requestedTicker?.trim() ||
    instruments.find((i) => i.held)?.ticker ||
    instruments[0]?.ticker ||
    "";
  const { selected, candidates } = resolveResearchIdentity(
    instruments,
    requested,
  );
  const ticker = selected?.ticker ?? requested;
  useEffect(() => {
    if (selected && requestedTicker && requestedTicker !== selected.ticker) {
      update({ ticker: selected.ticker });
    }
  }, [selected, requestedTicker, update]);
  const tab: ResearchTab = researchTabs.includes(
    params.get("view") as ResearchTab,
  )
    ? (params.get("view") as ResearchTab)
    : "overview";
  const fetching =
    selected?.status === "pending" || selected?.status === "running";
  const lensName = tab === "financials" ? "fundamentals" : tab;
  const revision = selected?.lastRunId ?? shell.data?.status.runId;
  const detail = tab === "overview" ? "summary"
    : tab === "technical" ? (params.get("technicalView") === "seasonality" ? "seasonality" : "summary")
    : tab === "ledger" ? (["filings", "news"].includes(params.get("notebook") ?? "notes") ? "documents" : "summary")
    : ["fundamentals", "financials"].includes(tab) && params.get("financialMode") !== "full" ? "summary"
    : "full";
  const lens = useQuery({
    ...researchLensQuery(ticker, lensName, revision, detail),
    enabled: Boolean(selected),
  });
  const quote = previousForIdentity(lens.data, lens.data?.ticker, ticker) ??
    client.getQueriesData<ResearchLensSnapshot>({ queryKey: ["workspace-research", ticker] })
      .map(([key, data]) => ({ data, updatedAt: client.getQueryState(key)?.dataUpdatedAt ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .find(({ data }) => data?.ticker === ticker)?.data;
  const isFund = ["ETF", "MUTUALFUND"].includes(
    quote?.context?.assetType ?? "",
  );
  // A held line on the quote's listing is quoted at its broker price everywhere on the page.
  const price = basisPrice(selected, quote?.context?.quote);
  // Lenses name the next report by the exchange's date and carry its sessions:
  // a lens left open refetches when that date turns or the sessions run out.
  useLensRefresh(ticker, quote?.context?.quote);
  const context = useQuery({
    ...researchLensQuery(ticker, "fundamentals", revision),
    enabled: Boolean(selected) && isFund && tab === "overview",
  });
  const prices = useOverviewPrices(ticker, revision ?? "", Boolean(selected) && tab === "overview");
  const fundEnabled = isFund && tab === "overview" && Boolean(context.data ?? lens.data) && !context.isPending;
  const fund = useQuery({
    ...fundQuery(ticker, context.data?.runId ?? lens.data?.runId ?? ""),
    enabled: fundEnabled,
  });
  const overviewWaiting = tab === "overview" && (
    prices.isPending && !prices.data || runtime.status === "loading" ||
    isFund && (context.isPending || fundEnabled && fund.isPending)
  );
  const technicalPrice = tab === "technical" && params.get("technicalView") !== "seasonality";
  const currentLens = !overviewWaiting && !lens.isPlaceholderData && lens.data ? {
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
  const waitingForResearch = !shown && !technicalPrice && (
    overviewWaiting || lens.isPending || fetching && !lens.isError
  );
  useEffect(() => {
    if (isFund && (tab === "valuation" || tab === "analyst"))
      update({ view: "overview" });
  }, [isFund, tab, update]);
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
      action: "refresh" | "remove" | "move";
      categoryId?: string;
    }) =>
      api(
        "/watchlist/" + encodeURIComponent(ticker),
        jsonRequest("POST", { action, categoryId }),
      ),
    onSuccess: async (_, variables) => {
      if (variables.action === "remove") {
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
      onAdd={() => setFinder(true)}
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
    ledger: t("记录", "Journal"),
  };
  return (
    <Page
      className="mx-research-page"
      title={t("证券研究", "Security research")}
      titleHidden
      actions={
        <>
          {/* With a security open, its name in the header is the switcher. */}
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
              <Tooltip label={<>{t("上一只证券", "Previous security")} <kbd>K</kbd></>}>
                <ActionIcon
                  variant="default"
                  aria-label={t("上一只证券", "Previous security")}
                  aria-keyshortcuts="K"
                  disabled={!previous}
                  onClick={() => previous && selectTicker(previous.ticker)}
                >
                  <CaretLeft size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={<>{t("下一只证券", "Next security")} <kbd>J</kbd></>}>
                <ActionIcon
                  variant="default"
                  aria-label={t("下一只证券", "Next security")}
                  aria-keyshortcuts="J"
                  disabled={!next}
                  onClick={() => next && selectTicker(next.ticker)}
                >
                  <CaretRight size={18} />
                </ActionIcon>
              </Tooltip>
              <ResearchComparison ticker={ticker} instruments={instruments} />
            </>
          )}
          <Tooltip label={t("添加证券", "Add security")}>
            <ActionIcon
              variant="default"
              aria-label={t("添加证券", "Add security")}
              onClick={() => setFinder(true)}
            >
              <Plus size={17} />
            </ActionIcon>
          </Tooltip>
          {selected && (
            <SecurityActions
              held={selected.held}
              categoriesAvailable={Boolean(shell.data?.watchlistCategories.length)}
              busy={operation.isPending || fetching}
              pending={operation.isPending}
              onRefresh={() => operation.mutate({ action: "refresh" })}
              onManage={() => setManage(true)}
              onRemove={() => setRemoveConfirm(true)}
            />
          )}
        </>
      }
    >
      {(shell.isPending || Boolean(selected && waitingForResearch)) &&
        <LoadingStatus label={t("正在读取证券研究…", "Loading security research…")} />}
      {shell.isPending ? (
        <Pending shape="research" quiet />
      ) : !shell.data && shell.isError ? (
        <QueryError retry={shell.refetch} />
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
              <Panel title={t("选择要查看的上市证券", "Choose a listing")}>
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
            ) : !selected ? (
              <Panel>
                <Empty
                  title={
                    ticker
                      ? ticker + t(" 还不在研究清单里", " is not in your research list")
                      : t(
                          "从一家你感兴趣的公司开始",
                          "Start with a company you are curious about",
                        )
                  }
                  description={
                    ticker
                      ? undefined
                      : t(
                          "搜索证券代码或公司名，逐步建立自己的研究范围。",
                          "Find a ticker or company and build a research universe of your own.",
                        )
                  }
                  action={
                    <Button
                      onClick={() => {
                        // Open the finder already searching for this ticker.
                        if (ticker) setFinderQuery(ticker);
                        setFinder(true);
                      }}
                    >
                      {ticker ? t("加入研究清单", "Add to research list") : t("查找证券", "Find a security")}
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
                  } : undefined}
                  listOpen={listOpen}
                  onSwitch={openUniverse}
                />
                <Tabs
                  label={t("证券研究视角", "Security research perspective")}
                  value={tab === "financials" ? "fundamentals" : tab}
                  onChange={(v) =>
                    update({ view: v === "overview" ? null : v })
                  }
                  options={(
                    [
                      "overview",
                      "fundamentals",
                      "technical",
                      "analyst",
                      "valuation",
                      "options",
                      "ledger",
                    ] as ResearchTab[]
                  )
                    .filter(
                      (value) =>
                        !(
                          ["ETF", "MUTUALFUND"].includes(
                            quote?.context?.assetType ?? "",
                          ) && ["valuation", "analyst"].includes(value)
                        ),
                    )
                    .map((value) => ({
                      value,
                      label:
                        isFund && value === "fundamentals"
                          ? t("持仓与跟踪", "Holdings & tracking")
                          : titles[value],
                      short:
                        isFund && value === "fundamentals"
                          ? t("持仓", "Holdings")
                          : shortTitles[value],
                    }))}
                />
                {operation.isError && (
                  <Notice tone="bad">
                    {t("操作未完成：", "The action did not complete: ")}
                    {operation.error.message}
                  </Notice>
                )}
                {waitingForResearch ? (
                  <Panel className="mx-research-wait">
                    <Pending shape="chart" height={338} quiet />
                  </Panel>
                ) : (
                <div className="mx-data-body mx-research-read" aria-busy={switching || undefined}>
                {displayTab === "overview" && shown && (runtime.status === "failed"
                  ? <QueryError retry={runtime.retry} />
                  : <PricePreview ticker={ticker} query={prices} summary={displayData?.technicalSummary} />
                )}
                {(tab === "technical" || displayTab === "technical") && <>
                          <Tabs
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
                          />
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
                  <QueryError retry={lens.refetch} />
                ) : (
                  displayData && (
                    <>
                      {displayTab === "overview" && (
                        <>
                          {isFund ? (
                            <FundWorkbench
                              overview
                              data={context.data ?? displayData}
                              onExplore={exploreHolding}
                            />
                          ) : (
                            <CompanyOverview
                              data={displayData}
                              context={context.data}
                              gics={selected.gics}
                            />
                          )}
                        </>
                      )}
                      {displayTab === "technical" && !shown?.technicalPrice && <Seasonality data={displayData} revision={revision} />}
                      {displayTab === "valuation" && (
                        <ValuationWorkbench data={displayData} revision={revision} price={price} />
                      )}
                      {displayTab === "fundamentals" &&
                        (isFund ? (
                          <FundWorkbench
                            data={displayData}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench data={displayData} />
                        ))}
                      {displayTab === "financials" &&
                        (isFund ? (
                          <FundWorkbench
                            data={displayData}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench
                            data={displayData}
                            initialMode="income"
                          />
                        ))}
                      {displayTab === "analyst" && (
                        <AnalystView data={displayData} revision={revision} price={price} />
                      )}
                      {displayTab === "options" && <OptionsView data={displayData} />}
                      {displayTab === "ledger" && (
                        <ResearchNotebook key={ticker} data={displayData} />
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
        onAdded={async (value) => {
          await shell.refetch();
          update({ ticker: value, fromFund: isFund ? ticker : null });
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
        title={t("移除研究标的", "Remove security")}
      >
        <Stack gap="lg">
          <p className="mx-prose">
            {ticker} ·{" "}
            {t(
              "将从研究清单中移除。券商持仓不受影响，你随时可以重新添加。",
              "This security will leave your research list. Broker positions are unaffected and you can add it again.",
            )}
          </p>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoveConfirm(false)}>
              {t("保留", "Keep security")}
            </Button>
            <Button
              color="red"
              loading={operation.isPending}
              onClick={() => operation.mutate({ action: "remove" })}
            >
              {t("移除", "Remove")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Page>
  );
}
