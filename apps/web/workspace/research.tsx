"use client";

import { quoteValue } from "./financial-values";
import {
  ActionIcon,
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
import {
  ArrowClockwise,
  DotsThree,
  List,
  MagnifyingGlass,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { resolveResearchIdentity } from "./research-identity";
import type {
  ResearchLensSnapshot,
  ResearchShell,
  SecuritySearchResponse,
  SecuritySearchResult,
} from "@/lib/types";
import {
  api,
  currency,
  jsonRequest,
  object,
  numeric,
  percent,
  tone,
} from "./data";
import {
  Empty,
  Freshness,
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
import { useRouteState } from "./route-state";
import { PriceHistory } from "./research-price";
import {
  CompanyOverview,
  TechnicalView,
  FundamentalsView,
  FinancialStatements,
  AnalystView,
  ResearchLedger,
} from "./research-company";
import { ValuationView, OptionsView } from "./research-models";
import { Narrative } from "./narrative";
import { Seasonality } from "./research-seasonality";

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
  const { params, update } = useRouteState();
  const [finder, setFinder] = useState(false);
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
    queryFn: () => api<ResearchShell>("/research/shell"),
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
  const lens = useQuery({
    queryKey: [
      "workspace-research",
      shell.data?.status.runId,
      selected?.lastRunId,
      ticker,
      lensName,
    ],
    enabled: Boolean(selected),
    queryFn: () =>
      api<ResearchLensSnapshot>(
        "/research/" +
          encodeURIComponent(ticker) +
          "/lens/" +
          lensName +
          "?limit=30",
      ),
    staleTime: 60_000,
  });
  const context = useQuery({
    queryKey: [
      "workspace-research",
      shell.data?.status.runId,
      selected?.lastRunId,
      ticker,
      "fundamentals",
    ],
    enabled: Boolean(selected) && (tab === "overview" || tab === "technical"),
    queryFn: () =>
      api<ResearchLensSnapshot>(
        "/research/" +
          encodeURIComponent(ticker) +
          "/lens/fundamentals?limit=30",
      ),
    staleTime: 60_000,
  });
  const quote =
    lens.data ??
    client
      .getQueriesData<ResearchLensSnapshot>({
        queryKey: [
          "workspace-research",
          shell.data?.status.runId,
          selected?.lastRunId,
          ticker,
        ],
      })
      .map(([, data]) => data)
      .find((data) => data?.ticker === ticker);
  const market = object(quote?.market);
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
      await client.invalidateQueries({ queryKey: ["workspace-research"] });
    },
  });
  function selectTicker(value: string) {
    update({ ticker: value });
    setUniverseOpen(false);
  }
  const universe = (
    <>
      <div className="mx-universe-heading">
        <h2>{t("研究清单", "Research universe")}</h2>
        <ActionIcon
          aria-label={t("添加证券", "Add security")}
          size={30}
          onClick={() => setFinder(true)}
        >
          <Plus size={16} />
        </ActionIcon>
      </div>
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
    overview: t("全貌", "Overview"),
    technical: t("技术走势", "Technicals"),
    valuation: t("估值模型", "Valuation"),
    fundamentals: t("经营质量", "Fundamentals"),
    financials: t("财务报表", "Financials"),
    analyst: t("市场预期", "Estimates"),
    options: t("期权结构", "Options"),
    ledger: t("研究记录", "Journal"),
  };
  const narrative = {
    overview: "watchlist_opportunity_map",
    technical: "technical_regime",
    valuation: "valuation_scenario",
    fundamentals: "fundamental_health",
    financials: "financial_statements",
    analyst: "analyst_consensus",
    options: "options_positioning",
    ledger: "thesis_change",
  } as const;
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
            onClick={() => setUniverseOpen(true)}
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
        <div className="mx-research-layout">
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
                <Panel className="mx-security-panel">
                  <div className="mx-security-header">
                    <div className="mx-security-name">
                      <div>
                        <h2>{selected.name || ticker}</h2>
                        <div className="mx-security-meta">
                          <strong>{ticker}</strong>
                          <span>{selected.exchange}</span>
                          {selected.held && (
                            <Tag tone="good">
                              {t("已持有 ", "Held ") +
                                currency(selected.exposureGbp)}
                            </Tag>
                          )}
                          <Freshness
                            date={String(
                              market.asOf ??
                                quote?.generatedAt ??
                                shell.data?.status.generatedAt ??
                                "",
                            )}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="mx-security-price">
                      <strong>
                        {quoteValue(
                          market.spot ??
                            quote?.technical?.price ??
                            quote?.valuation?.spot,
                          market.currency ||
                            quote?.technical?.currency ||
                            quote?.valuation?.currency,
                          t("币种未提供", "Currency unavailable"),
                        )}
                      </strong>
                      {numeric(market.dayReturn) != null && (
                        <small className={"mx-" + tone(market.dayReturn)}>
                          {percent(market.dayReturn, true, 2)} ·{" "}
                          {t("最近交易日", "Latest session")}
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="mx-research-controls">
                    <Group gap="xs">
                      <Button
                        variant="default"
                        size="xs"
                        leftSection={<ArrowClockwise size={14} />}
                        loading={operation.isPending || fetching}
                        onClick={() => operation.mutate({ action: "refresh" })}
                      >
                        {t("更新研究", "Update research")}
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
                  value={tab}
                  onChange={(v) =>
                    update({ view: v === "overview" ? null : v })
                  }
                  options={researchTabs.map((value) => ({
                    value,
                    label: titles[value],
                  }))}
                />
                {operation.isError && (
                  <Notice tone="bad">
                    {t("操作未完成：", "The action did not complete: ")}
                    {operation.error.message}
                  </Notice>
                )}
                {fetching && !lens.data ? (
                  <Panel>
                    <Notice>
                      {t(
                        "正在为这个标的收集研究数据。你可以继续查看其他标的。",
                        "Research data is being collected. You can keep exploring other securities.",
                      )}
                    </Notice>
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
                ) : lens.isError ? (
                  <QueryError retry={lens.refetch} />
                ) : (
                  lens.data && (
                    <>
                      {tab === "overview" && (
                        <>
                          <PriceHistory
                            ticker={ticker}
                            runId={selected.lastRunId ?? lens.data.runId}
                          />
                          <CompanyOverview
                            data={lens.data}
                            context={context.data}
                          />
                        </>
                      )}
                      {tab === "technical" && (
                        <>
                          <PriceHistory
                            ticker={ticker}
                            runId={selected.lastRunId ?? lens.data.runId}
                            technical
                          />
                          <TechnicalView data={lens.data} />
                          {context.data && <Seasonality data={context.data} />}
                        </>
                      )}
                      {tab === "valuation" && (
                        <ValuationView data={lens.data} />
                      )}
                      {tab === "fundamentals" && (
                        <FundamentalsView data={lens.data} />
                      )}
                      {tab === "financials" && (
                        <FinancialStatements data={lens.data} />
                      )}
                      {tab === "analyst" && <AnalystView data={lens.data} />}
                      {tab === "options" && <OptionsView data={lens.data} />}
                      {tab === "ledger" && <ResearchLedger data={lens.data} />}
                      <Narrative
                        snapshot={lens.data.runId}
                        lens={narrative[tab]}
                        page={tab === "overview" ? "research" : tab}
                        ticker={ticker}
                      />
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
        title={t("选择研究标的", "Choose a security")}
        size={360}
      >
        {universe}
      </Drawer>
      <SecurityFinder
        opened={finder}
        onClose={() => setFinder(false)}
        initial={selected ? "" : ticker}
        onAdded={async (value) => {
          await shell.refetch();
          update({ ticker: value });
          setFinder(false);
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
  const query = useQuery({
    queryKey: ["workspace-security-search", search],
    enabled: opened && search.length >= 2,
    queryFn: () =>
      api<SecuritySearchResponse>(
        "/securities/search?q=" + encodeURIComponent(search),
      ),
    retry: 0,
  });
  const add = useMutation({
    mutationFn: (security: SecuritySearchResult) =>
      api("/watchlist", jsonRequest("POST", { security, refresh: true })),
    onSuccess: async (_, security) => onAdded(security.ticker),
  });
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSearch((text || initial).trim());
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
            onChange={(e) => setText(e.currentTarget.value)}
            leftSection={<MagnifyingGlass size={18} />}
          />
          <Button
            type="submit"
            disabled={(text || initial).trim().length < 2}
            loading={query.isFetching}
          >
            {t("搜索", "Search")}
          </Button>
        </Group>
      </form>
      {add.isError && <Notice tone="bad">{add.error.message}</Notice>}
      {query.isError ? (
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
            {query.data.results.map((r, i) => (
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
