"use client";

import type {
  ResearchLensSnapshot,
  ResearchShell,
  SecuritySearchResponse,
  SecuritySearchResult,
} from "@/lib/types";
import {
  ActionIcon,
  Avatar,
  Button,
  Checkbox,
  Drawer,
  Group,
  Menu,
  Modal,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { useLocalStorage, useMediaQuery } from "@mantine/hooks";
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  DotsThree,
  List,
  MagnifyingGlass,
  Plus,
  PushPin,
  Trash,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, currency, jsonRequest, object, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import {
  Empty,
  Instrument,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Tabs,
  Tag,
  useCopy,
} from "./foundation";
import {
  AnalystView,
  CompanyOverview,
  TechnicalView,
} from "./research-company";
import { ResearchComparison } from "./research-compare";
import { FinancialWorkbench } from "./research-financials";
import { FundWorkbench } from "./research-funds";
import { resolveResearchIdentity } from "./research-identity";
import { ResearchNotebook } from "./research-notebook";
import { OptionsView } from "./research-options";
import { PriceHistory } from "./research-price";
import { PricePreview } from "./research-price-preview";
import { Seasonality } from "./research-seasonality";
import { ValuationWorkbench } from "./research-valuation-workbench";
import { researchLensQuery } from "./research-queries";
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
  const [filter, setFilter] = useState("");
  const [heldOnly, setHeldOnly] = useState(false);
  const [category, setCategory] = useState("all");
  const [listSort, setListSort] = useState("held");
  const [manage, setManage] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const client = useQueryClient();
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
  const quote =
    lens.data ??
    client
      .getQueriesData<ResearchLensSnapshot>({
        queryKey: ["workspace-research", ticker],
      })
      .map(([, data]) => data)
      .find((data) => data?.ticker === ticker);
  const market = object(quote?.market);
  const isFund = ["ETF", "MUTUALFUND"].includes(
    quote?.context?.assetType ?? "",
  );
  const context = useQuery({
    ...researchLensQuery(ticker, "fundamentals", revision),
    enabled: Boolean(selected) && isFund && tab === "overview",
  });
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
  const displayed = instruments
    .filter(
      (i) =>
        (!heldOnly || i.held) &&
        (category === "all" || i.categoryId === category) &&
        (i.ticker + i.name).toLowerCase().includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) =>
      listSort === "az"
        ? a.ticker.localeCompare(b.ticker)
        : Number(b.held) - Number(a.held) || a.order - b.order,
    );
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
  const universeHeading = (
    <span className="mx-universe-heading">
      <span>{t("研究清单", "Research list")}</span>
      <Group component="span" gap={4}>
        {wide && (
          <ActionIcon
            aria-label={
              pinned
                ? t("取消固定研究清单", "Unpin research list")
                : t("固定研究清单", "Pin research list")
            }
            aria-pressed={pinned}
            variant={pinned ? "light" : "subtle"}
            onClick={() => {
              setPinned(!pinned);
              setUniverseOpen(pinned);
            }}
          >
            <PushPin size={17} weight={pinned ? "fill" : "regular"} />
          </ActionIcon>
        )}
        <ActionIcon
          aria-label={t("添加证券", "Add security")}
          size={30}
          onClick={() => setFinder(true)}
        >
          <Plus size={16} />
        </ActionIcon>
      </Group>
    </span>
  );
  const universe = (
    <>
      <TextInput
        size="xs"
        aria-label={t("筛选研究清单", "Filter research list")}
        placeholder={t("筛选研究清单…", "Filter research list…")}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        leftSection={<MagnifyingGlass size={15} />}
      />
      <Select
        mt="sm"
        size="xs"
        aria-label={t("研究分类", "Research category")}
        value={category}
        onChange={(v) => setCategory(v ?? "all")}
        data={[
          { value: "all", label: t("全部分类", "All categories") },
          ...(shell.data?.watchlistCategories ?? []).map((c) => ({
            value: c.id,
            label:
              t(c.labelZh, c.labelEn) +
              " · " +
              instruments.filter((i) => i.categoryId === c.id).length,
          })),
        ]}
      />
      <Select
        mt="sm"
        size="xs"
        aria-label={t("研究清单排序", "Research list order")}
        value={listSort}
        onChange={(v) => setListSort(v ?? "held")}
        data={[
          { value: "held", label: t("持仓优先", "Held first") },
          { value: "az", label: t("代码 A–Z", "Ticker A–Z") },
        ]}
      />
      <Checkbox
        mt="md"
        size="xs"
        checked={heldOnly}
        onChange={(e) => setHeldOnly(e.currentTarget.checked)}
        label={t("仅看我的持仓", "Held in my portfolio")}
      />
      <div className="mx-watchlist">
        {displayed.map((i) => (
          <button
            key={i.ticker}
            className="mx-watchlist-item"
            data-selected={ticker === i.ticker || undefined}
            onClick={() => selectTicker(i.ticker)}
            aria-label={t("研究 ", "Research ") + i.ticker}
          >
            <Instrument ticker={i.ticker} name={i.name} small />
            {i.held && (
              <span
                className="mx-status-dot"
                aria-label={t("已持有", "Held")}
              />
            )}
          </button>
        ))}
      </div>
      {!displayed.length && (
        <p className="mx-form-help">
          {t("没有匹配的标的。", "No securities match this filter.")}
        </p>
      )}
    </>
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
  return (
    <Page
      className="mx-research-page"
      title={t("证券研究", "Security research")}
      actions={
        <Group gap="sm">
          <Button
            className="mx-universe-toggle"
            variant="default"
            leftSection={<List size={17} />}
            aria-expanded={universeOpen || (wide && pinned)}
            onClick={() => {
              if (wide && pinned)
                document
                  .querySelector<HTMLInputElement>(
                    ".mx-research-universe input",
                  )
                  ?.focus();
              else setUniverseOpen(true);
            }}
          >
            {t("研究清单", "Research list")}
          </Button>
          <Button
            leftSection={<Plus size={16} />}
            onClick={() => setFinder(true)}
          >
            {t("添加证券", "Add security")}
          </Button>
        </Group>
      }
    >
      {shell.isPending ? (
        <Pending />
      ) : shell.isError ? (
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
                      ? t(
                          "把这个标的加入研究",
                          "Add this security to your research",
                        )
                      : t(
                          "从一家你感兴趣的公司开始",
                          "Start with a company you are curious about",
                        )
                  }
                  description={
                    ticker
                      ? ticker +
                        " · " +
                        t(
                          "当前不在研究清单中。搜索并添加后即可加载完整研究。",
                          "This security is not in your research list. Find and add it to load research.",
                        )
                      : t(
                          "搜索证券代码或公司名，逐步建立自己的研究范围。",
                          "Find a ticker or company and build a research universe of your own.",
                        )
                  }
                  action={
                    <Button onClick={() => setFinder(true)}>
                      {t("查找证券", "Find a security")}
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
                <Panel className="mx-security-panel">
                  <div className="mx-security-header">
                    <div className="mx-security-name">
                      <Avatar
                        key={ticker}
                        src={`/api/company-logo/${encodeURIComponent(ticker)}`}
                        alt=""
                        aria-hidden="true"
                        size={48}
                        radius="md"
                        className="mx-company-logo"
                      >
                        {ticker.slice(0, 2)}
                      </Avatar>
                      <div>
                        <h2>{selected.name || ticker}</h2>
                        <div className="mx-security-meta">
                          <strong>{ticker}</strong>
                          <span>
                            {quote?.context?.quote.exchange ||
                              (
                                {
                                  NMS: "NASDAQ",
                                  NGM: "NASDAQ",
                                  NCM: "NASDAQ",
                                  NYQ: "NYSE",
                                  LSE: "London Stock Exchange",
                                } as Record<string, string>
                              )[selected.exchange] ||
                              selected.exchange}
                          </span>
                          {selected.held && (
                            <Tag tone="good">
                              {t("已持有 ", "Held ") +
                                currency(selected.exposureGbp)}
                            </Tag>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="mx-security-price">
                      <strong>
                        {quoteValue(
                          quote?.context?.quote.price ??
                            market.spot ??
                            quote?.technical?.price ??
                            quote?.valuation?.spot,
                          quote?.context?.quote.currency || market.currency,

                          t("币种未提供", "Currency unavailable"),
                        )}
                      </strong>
                      {quote?.context?.quote.changePct != null && (
                        <small
                          className={
                            "mx-" + tone(quote.context.quote.changePct)
                          }
                        >
                          {percent(quote.context.quote.changePct, true, 2)} ·{" "}
                          {quoteValue(
                            quote.context.quote.change,
                            quote.context.quote.currency,
                            "—",
                          )}
                        </small>
                      )}
                      {quote?.context?.quote.asOf && (
                        <small>
                          {new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: quote.context.quote.timezone ?? "UTC",
                            timeZoneName: "short",
                          }).format(new Date(quote.context.quote.asOf))}{" "}
                          ·{" "}
                          {(
                            {
                              regular: t("常规交易", "Regular session"),
                              closed: t("收盘", "Closed"),
                              post: t("盘后", "Post-market"),
                              pre: t("盘前", "Pre-market"),
                            } as Record<string, string>
                          )[quote.context.quote.session] ??
                            t("最近报价", "Latest quote")}
                          {quote.context.quote.delayMinutes
                            ? ` · ${quote.context.quote.delayMinutes} min`
                            : ""}
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="mx-research-controls">
                    <Group gap="xs">
                      <ResearchComparison
                        ticker={ticker}
                        instruments={instruments}
                      />
                      <ActionIcon
                        aria-label={t("上一只证券", "Previous security")}
                        disabled={
                          displayed.findIndex((i) => i.ticker === ticker) <= 0
                        }
                        onClick={() =>
                          selectTicker(
                            displayed[
                              displayed.findIndex((i) => i.ticker === ticker) -
                                1
                            ].ticker,
                          )
                        }
                      >
                        <CaretLeft size={18} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label={t("下一只证券", "Next security")}
                        disabled={
                          displayed.findIndex((i) => i.ticker === ticker) < 0 ||
                          displayed.findIndex((i) => i.ticker === ticker) >=
                            displayed.length - 1
                        }
                        onClick={() =>
                          selectTicker(
                            displayed[
                              displayed.findIndex((i) => i.ticker === ticker) +
                                1
                            ].ticker,
                          )
                        }
                      >
                        <CaretRight size={18} />
                      </ActionIcon>
                      <Button
                        aria-label={t("更新研究", "Update research")}
                        variant="default"
                        size="xs"
                        leftSection={<ArrowClockwise size={14} />}
                        loading={operation.isPending || fetching}
                        onClick={() => operation.mutate({ action: "refresh" })}
                      >
                        <span className="mx-action-long">
                          {t("更新研究", "Update research")}
                        </span>
                        <span className="mx-action-short">
                          {t("更新", "Update")}
                        </span>
                      </Button>
                      <Menu shadow="md">
                        <Menu.Target>
                          <ActionIcon
                            aria-label={t(
                              "管理当前证券",
                              "Manage this security",
                            )}
                          >
                            <DotsThree size={23} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            disabled={!shell.data?.watchlistCategories.length}
                            onClick={() => setManage(true)}
                          >
                            {shell.data?.watchlistCategories.length
                              ? t("调整研究分类", "Change research category")
                              : t(
                                  "尚未设置研究分类",
                                  "No research categories configured",
                                )}
                          </Menu.Item>
                          <Menu.Item
                            color="red"
                            disabled={selected.held || operation.isPending}
                            leftSection={<Trash size={15} />}
                            onClick={() => setRemoveConfirm(true)}
                          >
                            {selected.held
                              ? t(
                                  "持仓标的保留在研究中",
                                  "Held securities stay in research",
                                )
                              : t("从研究清单移除", "Remove from research")}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </div>
                </Panel>
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
                    }))}
                />
                {operation.isError && (
                  <Notice tone="bad">
                    {t("操作未完成：", "The action did not complete: ")}
                    {operation.error.message}
                  </Notice>
                )}
                {tab === "overview" && (
                  <PricePreview ticker={ticker} runId={revision ?? ""} />
                )}
                {tab === "technical" && <>
                          <Tabs
                            label={t(
                              "价格与技术内容",
                              "Price & technical sections",
                            )}
                            value={
                              ["price", "data", "seasonality"].includes(
                                params.get("technicalView") ?? "",
                              )
                                ? params.get("technicalView")!
                                : "price"
                            }
                            onChange={(v) =>
                              update({
                                technicalView: v === "price" ? null : v,
                              })
                            }
                            options={[
                              { value: "price", label: t("走势", "Chart") },
                              {
                                value: "data",
                                label: t("技术数据", "Technical data"),
                              },
                              {
                                value: "seasonality",
                                label: t("季节性", "Seasonality"),
                              },
                            ]}
                          />
                          {!["data", "seasonality"].includes(
                            params.get("technicalView") ?? "",
                          ) && (
                            <PriceHistory
                              key={ticker}
                              ticker={ticker}
                              runId={revision ?? ""}
                              technical
                              context={lens.data}
                            />
                          )}
                </>}
                {tab === "technical" && !["data", "seasonality"].includes(params.get("technicalView") ?? "") ? null : fetching && !lens.data ? (
                  <Panel>
                    <Pending />
                  </Panel>
                ) : selected.status === "failed" && !lens.data ? (
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
                ) : lens.isPending ? (
                  <Pending />
                ) : lens.isError && !lens.data ? (
                  <QueryError retry={lens.refetch} />
                ) : (
                  lens.data && (
                    <>
                      {tab === "overview" && (
                        <>
                          {isFund ? (
                            <FundWorkbench
                              overview
                              data={context.data ?? lens.data}
                              onExplore={exploreHolding}
                            />
                          ) : (
                            <CompanyOverview
                              data={lens.data}
                              context={context.data}
                            />
                          )}
                        </>
                      )}
                      {tab === "technical" && params.get("technicalView") === "data" && <TechnicalView data={lens.data} />}
                      {tab === "technical" && params.get("technicalView") === "seasonality" && <Seasonality data={lens.data} revision={revision} />}
                      {tab === "valuation" && (
                        <ValuationWorkbench data={lens.data} revision={revision} />
                      )}
                      {tab === "fundamentals" &&
                        (isFund ? (
                          <FundWorkbench
                            data={lens.data}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench data={lens.data} />
                        ))}
                      {tab === "financials" &&
                        (isFund ? (
                          <FundWorkbench
                            data={lens.data}
                            onExplore={exploreHolding}
                          />
                        ) : (
                          <FinancialWorkbench
                            data={lens.data}
                            initialMode="income"
                          />
                        ))}
                      {tab === "analyst" && <AnalystView data={lens.data} revision={revision} />}
                      {tab === "options" && <OptionsView data={lens.data} />}
                      {tab === "ledger" && (
                        <ResearchNotebook key={ticker} data={lens.data} />
                      )}
                    </>
                  )
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
function SecurityFinder({
  opened,
  onClose,
  initial,
  onAdded,
}: {
  opened: boolean;
  onClose: () => void;
  initial: string;
  onAdded: (ticker: string) => Promise<void>;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const currentText = (text || initial).trim();
  const showingCurrentSearch = search === currentText;
  const query = useQuery({
    queryKey: ["workspace-security-search", opened ? search : "", 3],
    enabled: opened && search.length >= 2,
    queryFn: ({ signal }) =>
      api<SecuritySearchResponse>(
        "/securities/search?q=" + encodeURIComponent(search), { signal },
      ),
    staleTime: 60_000,
    retry: 0,
  });
  const add = useMutation({
    mutationFn: (security: SecuritySearchResult) =>
      api("/watchlist", jsonRequest("POST", { security, refresh: true })),
    onSuccess: async (_, security) => onAdded(security.ticker),
  });
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (currentText.length < 2) return;
    if (showingCurrentSearch) void query.refetch();
    else setSearch(currentText);
  }
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("添加证券", "Add security")}
      size={620}
    >
      <form onSubmit={submit}>
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <TextInput
            flex={1}
            data-autofocus
            aria-label={t("搜索证券", "Search securities")}
            placeholder={
              initial || t("证券代码或公司名", "Ticker or company name")
            }
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.currentTarget.value)}
            leftSection={<MagnifyingGlass size={18} />}
          />
          <Button
            type="submit"
            disabled={currentText.length < 2}
            loading={query.isFetching && showingCurrentSearch}
          >
            {t("搜索", "Search")}
          </Button>
        </Group>
      </form>
      {add.isError && <Notice tone="bad">{add.error.message}</Notice>}
      {!showingCurrentSearch ? null : query.isError ? (
        <Notice tone="bad">
          {t(
            "搜索暂时不可用，请稍后重试。",
            "Search is temporarily unavailable. Please retry.",
          )}
        </Notice>
      ) : search.length >= 2 && query.isPending ? (
        <Pending compact />
      ) : query.data ? (
        query.data.results.length ? (
          <div style={{ marginTop: 20 }}>
            {query.data.results.slice(0, 3).map((r, i) => (
              <div className="mx-row-link" key={r.figi || r.ticker + i}>
                <Instrument ticker={r.ticker} name={r.name} small />
                <span className="mx-form-help">{r.exchange}</span>
                <Button
                  size="xs"
                  variant={r.alreadyWatched ? "default" : "light"}
                  loading={add.isPending && add.variables?.ticker === r.ticker}
                  disabled={add.isPending}
                  onClick={() =>
                    r.alreadyWatched ? void onAdded(r.ticker) : add.mutate(r)
                  }
                >
                  {r.alreadyWatched ? t("查看", "Open") : t("添加", "Add")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title={t("没有找到匹配证券", "No matching securities")}
            description={t(
              "尝试使用交易所代码或公司全名。",
              "Try an exchange ticker or the full company name.",
            )}
          />
        )
      ) : (
        <Empty
          title={t("搜索证券", "Search for a security")}
          description={t(
            "输入至少两个字符，搜索可研究的证券。",
            "Enter at least two characters to search available securities.",
          )}
        />
      )}
    </Modal>
  );
}
