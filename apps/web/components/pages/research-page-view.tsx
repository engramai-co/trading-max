"use client";

import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsLeftRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { Localized, useLocale } from "@/components/locale-provider";
import { PageHeader } from "@/components/page-header";
import { ResearchLens, type ResearchView } from "@/components/research/research-lens";
import { ResearchNavigation } from "@/components/research/research-navigation";
import { ResearchRefreshButton } from "@/components/research/research-refresh-button";
import { CompanyMark } from "@/components/company-mark";
import { money } from "@/lib/format";
import {
  loadMockResearchLens,
  loadMockResearchPrices,
} from "@/lib/mock-research";
import { fetchResearchPrices } from "@/lib/research-prices";
import {
  mergeResearchInstruments,
} from "@/lib/research-view";
import {
  researchLensQueryKey,
  researchPricesQueryKey,
} from "@/lib/research-query";
import type {
  ResearchLensSnapshot,
  ResearchInstrument,
  ResearchShell,
  SecuritySearchResult,
} from "@/lib/types";
import {
  pendingResearchInstrument,
  researchDataRunId,
  researchShellNeedsPolling,
  researchWorkIsPending,
  taxonomyDisplayStatus,
} from "@/lib/watchlist";

const views: Array<{ key: ResearchView; zh: string; en: string }> = [
  { key: "overview", zh: "总览", en: "Overview" },
  { key: "technical", zh: "技术面", en: "Technical" },
  { key: "valuation", zh: "估值", en: "Valuation" },
  { key: "fundamentals", zh: "基本面与报表", en: "Fundamentals" },
  { key: "analyst", zh: "一致预期", en: "Estimates" },
  { key: "options", zh: "期权", en: "Options" },
  { key: "ledger", zh: "账本", en: "Ledger" },
];

async function fetchResearchLens(
  ticker: string,
  view: ResearchView,
): Promise<ResearchLensSnapshot> {
  const response = await fetch(
    `/api/backend/research/${encodeURIComponent(ticker)}/lens/${view}?limit=30`,
  );
  if (!response.ok) throw new Error(`research lens returned ${response.status}`);
  return (await response.json()) as ResearchLensSnapshot;
}

async function fetchResearchShell(): Promise<ResearchShell> {
  const response = await fetch("/api/backend/research/shell");
  if (!response.ok) throw new Error(`research shell returned ${response.status}`);
  return (await response.json()) as ResearchShell;
}

export function ResearchPageView({
  shell,
  ticker,
  view,
  mock = false,
}: {
  shell: ResearchShell;
  ticker: string;
  view: ResearchView;
  mock?: boolean;
}) {
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const initialTicker = shell.instruments.some((item) => item.ticker === ticker)
    ? ticker
    : shell.instruments.find((item) => item.held)?.ticker
      ?? shell.instruments[0]?.ticker
      ?? ticker;
  const [activeTicker, setActiveTicker] = useState(initialTicker);
  const [activeView, setActiveView] = useState(view);
  const [pickerSignal, setPickerSignal] = useState(0);
  const [optimisticInstruments, setOptimisticInstruments] = useState<ResearchInstrument[]>([]);
  const [removedTickers, setRemovedTickers] = useState<Set<string>>(
    () => new Set(),
  );
  const optimisticTickers = useMemo(
    () => new Set(optimisticInstruments.map((item) => item.ticker)),
    [optimisticInstruments],
  );
  const liveShell = useQuery({
    enabled: !mock,
    initialData: shell,
    queryFn: fetchResearchShell,
    queryKey: ["research-shell", ...Array.from(optimisticTickers).sort()],
    refetchInterval: (query) => {
      const current = query.state.data?.instruments ?? shell.instruments;
      return researchShellNeedsPolling(current) ? 2_000 : false;
    },
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  const instruments = useMemo(
    () => mergeResearchInstruments(
      [
        shell.instruments,
        optimisticInstruments,
        liveShell.data?.instruments ?? [],
      ],
      removedTickers,
    ),
    [
      liveShell.data?.instruments,
      optimisticInstruments,
      removedTickers,
      shell.instruments,
    ],
  );
  const instrument = instruments.find((item) => item.ticker === activeTicker);
  const researchPending = instrument ? researchWorkIsPending(instrument) : false;
  const researchFailed = instrument?.status === "failed";
  const watchlistCategories = liveShell.data?.watchlistCategories ?? shell.watchlistCategories;
  const category = watchlistCategories.find(
    (item) => item.id === instrument?.categoryId,
  );
  const taxonomyStatus = instrument ? taxonomyDisplayStatus(instrument) : null;
  const taxonomyLabel = locale === "zh"
    ? instrument?.taxonomyLabelZh
    : instrument?.taxonomyLabelEn;
  const researchRunId = researchDataRunId(
    instrument,
    liveShell.data?.status.runId ?? shell.status.runId,
  );
  const lens = useQuery({
    enabled: Boolean(instrument) && !researchPending && !researchFailed,
    queryFn: () => mock
      ? loadMockResearchLens(activeTicker, activeView, locale)
      : fetchResearchLens(activeTicker, activeView),
    queryKey: researchLensQueryKey(
      researchRunId,
      activeTicker,
      activeView,
      mock,
      locale,
    ),
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const needsPrices =
    activeView === "overview"
    || activeView === "technical"
    || activeView === "analyst";
  const prices = useQuery({
    enabled: Boolean(instrument) && needsPrices && !researchPending && !researchFailed,
    queryFn: () => mock
      ? loadMockResearchPrices(activeTicker)
      : fetchResearchPrices(activeTicker),
    queryKey: researchPricesQueryKey(researchRunId, activeTicker, mock),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const market = lens.data?.market;
  const marketSpot =
    market && typeof market.spot === "number" ? market.spot : null;
  const technical = lens.data?.technical ?? null;
  const valuation = lens.data?.valuation ?? null;
  const displayPrice = technical?.price ?? valuation?.spot ?? marketSpot;
  const displayCurrency =
    technical?.currency
    ?? valuation?.currency
    ?? (market && typeof market.currency === "string" ? market.currency : "USD");

  useEffect(() => {
    if (!lens.data || (needsPrices && !prices.data)) return;
    performance.mark("tm:data-ready");
  }, [lens.data, needsPrices, prices.data]);

  function replaceUrl(nextTicker: string, nextView: ResearchView) {
    const query = new URLSearchParams(window.location.search);
    query.set("ticker", nextTicker);
    query.set("view", nextView);
    window.history.replaceState(null, "", `/research?${query}`);
  }

  function selectTicker(nextTicker: string) {
    setActiveTicker(nextTicker);
    replaceUrl(nextTicker, activeView);
  }

  function addTicker(security: SecuritySearchResult) {
    const localPreviewLabel = locale === "zh" ? "本地预览" : "Local preview";
    setRemovedTickers((current) => {
      if (!current.has(security.ticker)) return current;
      const next = new Set(current);
      next.delete(security.ticker);
      return next;
    });
    setOptimisticInstruments((current) => {
      if (instruments.some((item) => item.ticker === security.ticker)) return current;
      const nextOrder = Math.max(0, ...instruments.map((item) => item.order)) + 1;
      const pendingInstrument = pendingResearchInstrument(security, nextOrder);
      return [
        ...current,
        mock
          ? {
            ...pendingInstrument,
            lastRunId: "mock-research-v2",
            status: "ready" as const,
            taxonomyLabelEn: localPreviewLabel,
            taxonomyLabelZh: localPreviewLabel,
            taxonomyStatus: "assigned" as const,
          }
          : pendingInstrument,
      ];
    });
    selectTicker(security.ticker);
  }

  function removeTicker(tickerToRemove: string) {
    const fallback = instruments.find(
      (item) => item.ticker !== tickerToRemove && item.held,
    ) ?? instruments.find((item) => item.ticker !== tickerToRemove);
    setRemovedTickers((current) => new Set(current).add(tickerToRemove));
    setOptimisticInstruments((current) => (
      current.filter((item) => item.ticker !== tickerToRemove)
    ));
    if (activeTicker === tickerToRemove && fallback) {
      selectTicker(fallback.ticker);
    }
    void queryClient.invalidateQueries({ queryKey: ["research-shell"] });
  }

  function selectView(next: ResearchView) {
    setActiveView(next);
    replaceUrl(activeTicker, next);
  }

  function prefetchView(next: ResearchView) {
    if (!instrument || researchPending || researchFailed) return;
    void queryClient.prefetchQuery({
      queryFn: () => mock
        ? loadMockResearchLens(activeTicker, next, locale)
        : fetchResearchLens(activeTicker, next),
      queryKey: researchLensQueryKey(
        researchRunId,
        activeTicker,
        next,
        mock,
        locale,
      ),
      staleTime: Number.POSITIVE_INFINITY,
    });
    if (next === "overview" || next === "technical" || next === "analyst") {
      void queryClient.prefetchQuery({
        queryFn: () => mock
          ? loadMockResearchPrices(activeTicker)
          : fetchResearchPrices(activeTicker),
        queryKey: researchPricesQueryKey(researchRunId, activeTicker, mock),
        staleTime: Number.POSITIVE_INFINITY,
      });
    }
  }

  const researchDate = useMemo(
    () => (liveShell.data?.status.generatedAt ?? shell.status.generatedAt).slice(0, 10),
    [liveShell.data?.status.generatedAt, shell.status.generatedAt],
  );

  return (
    <Stack gap="xl">
      <PageHeader
        actions={(
          <Group gap="xs">
            {mock ? (
              <Badge color="blue" size="lg" variant="light">
                {activeView === "valuation" ? (
                  <Localized zh="公开事实 + 模型假设 · 本地预览" en="Public facts + model assumptions · local preview" />
                ) : (
                  <Localized zh="合成数据 · 本地预览" en="Synthetic · local preview" />
                )}
              </Badge>
            ) : null}
            <Badge color="yellow" size="lg">{researchDate}</Badge>
          </Group>
        )}
        description={<Localized zh="查看价格、技术面、估值、财报、预期和期权数据。" en="Review prices, technicals, valuation, financials, expectations, and options." />}
        title={<Localized zh="研究台" en="Research workbench" />}
      />

      <Paper p="lg" withBorder>
        <Stack gap="md">
          <Group justify="space-between" wrap="wrap">
            <Group>
              <CompanyMark
                name={instrument?.name ?? activeTicker}
                size={52}
                ticker={activeTicker}
                website={instrument?.website}
              />
              <div>
                <Group gap="xs">
                  <Title order={2}>{instrument?.name ?? activeTicker}</Title>
                  <Badge variant="light">{activeTicker}</Badge>
                  {taxonomyStatus === "classifying" ? (
                    <Badge color="blue" leftSection={<Loader color="blue" size={10} />} variant="light">
                      <Localized zh="分类中" en="Classifying" />
                    </Badge>
                  ) : taxonomyStatus === "needs-review" ? (
                    <Badge color="yellow" variant="light">
                      <Localized zh="需确认" en="Review needed" />
                    </Badge>
                  ) : taxonomyStatus === "assigned" ? (
                    <Badge color="teal" variant="light">
                      <Localized zh="已归类" en="Classified" />
                    </Badge>
                  ) : null}
                </Group>
                <Text c="dimmed" size="sm">
                  {[
                    instrument?.exchange,
                    instrument?.bloombergTicker,
                    taxonomyLabel
                      ?? (locale === "zh" ? category?.labelZh : category?.labelEn),
                  ].filter(Boolean).join(" · ")}
                </Text>
                {researchPending ? (
                  <Group aria-live="polite" gap={6} mt={5} role="status">
                    <Loader size={13} />
                    <Text c="blue" size="sm">
                      <Localized zh="已添加，正在更新数据…" en="Added. Updating data…" />
                    </Text>
                  </Group>
                ) : null}
              </div>
            </Group>
            <Group>
              <div>
                {lens.isPending ? (
                  <Skeleton h={28} w={120} />
                ) : (
                  <Text fw={800} size="xl">
                    {displayPrice == null
                      ? "—"
                      : money(displayPrice, displayCurrency, 2)}
                  </Text>
                )}
                {instrument?.held ? (
                  <Badge color="green">
                    <Localized
                      zh={`持仓 · £${instrument.exposureGbp.toFixed(0)}`}
                      en={`Held · £${instrument.exposureGbp.toFixed(0)}`}
                    />
                  </Badge>
                ) : null}
              </div>
              <Button
                leftSection={<ArrowsLeftRight size={18} />}
                onClick={() => setPickerSignal((value) => value + 1)}
                variant="default"
              >
                <Localized zh="切换标的" en="Switch ticker" />
              </Button>
              {mock ? null : (
                <ResearchRefreshButton
                  onQueued={() => void liveShell.refetch()}
                  ticker={activeTicker}
                />
              )}
            </Group>
          </Group>
          <ResearchTabs
            onChange={selectView}
            onIntent={prefetchView}
            view={activeView}
          />
        </Stack>
      </Paper>

      <ResearchNavigation
        categories={watchlistCategories}
        instruments={instruments}
        mock={mock}
        onTickerAdded={addTicker}
        onTickerRemoved={removeTicker}
        onSelectTicker={selectTicker}
        openSignal={pickerSignal}
        selectedTicker={activeTicker}
      />

      <ResearchLens
        error={lens.isError || researchFailed}
        loading={!researchFailed && (researchPending || lens.isPending)}
        payload={lens.data ?? null}
        priceSeries={prices.data?.points ?? []}
        priceSeriesError={prices.isError}
        priceSeriesLoading={needsPrices && prices.isPending}
        showValuationAssumptions={!mock}
        ticker={activeTicker}
        tradeMarkers={prices.data?.tradeMarkers ?? []}
        view={activeView}
      />
    </Stack>
  );
}

function ResearchTabs({
  onChange,
  onIntent,
  view,
}: {
  onChange: (view: ResearchView) => void;
  onIntent: (view: ResearchView) => void;
  view: ResearchView;
}) {
  const { locale } = useLocale();
  return (
    <ScrollArea
      offsetScrollbars
      scrollbarSize={6}
      type="auto"
      viewportProps={{ tabIndex: 0 }}
    >
      <Group
        aria-label={locale === "zh" ? "研究页面" : "Research views"}
        gap="xs"
        pb={4}
        role="tablist"
        wrap="nowrap"
        w="max-content"
      >
        {views.map((item) => (
          <Button
            aria-selected={view === item.key}
            key={item.key}
            onClick={() => onChange(item.key)}
            onFocus={() => onIntent(item.key)}
            onMouseEnter={() => onIntent(item.key)}
            role="tab"
            style={{ flexShrink: 0 }}
            variant={view === item.key ? "filled" : "subtle"}
          >
            <Localized zh={item.zh} en={item.en} />
          </Button>
        ))}
      </Group>
    </ScrollArea>
  );
}
