"use client";

import {
  Accordion,
  Alert,
  Badge,
  Divider,
  Grid,
  Group,
  List,
  Paper,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Info } from "@phosphor-icons/react";

import { AnalystView } from "@/components/analyst-view";
import { Localized } from "@/components/locale-provider";
import { PriceChart } from "@/components/price-chart";
import { ValuationAssumptionsPanel } from "@/components/valuation-assumptions-panel";
import { FundamentalsLens } from "@/components/research/fundamentals-lens";
import { OptionsChainView } from "@/components/research/options-chain-view";
import {
  ValuationPriceChart,
  ValuationSensitivityChart,
} from "@/components/research/valuation-charts";
import { deltaPct, gbp, money, pct, ratio, shortDate } from "@/lib/format";
import type {
  OptionSnapshot,
  PriceSeriesPoint,
  ResearchLensSnapshot,
  ResearchTradeMarker,
  TechnicalRow,
  ValuationRow,
} from "@/lib/types";

export type ResearchView =
  | "overview"
  | "technical"
  | "valuation"
  | "fundamentals"
  | "analyst"
  | "options"
  | "ledger";

export function ResearchLens({
  error,
  loading,
  payload,
  priceSeries,
  priceSeriesError,
  priceSeriesLoading,
  tradeMarkers,
  referencePrice,
  showValuationAssumptions = true,
  ticker,
  view,
}: {
  error: boolean;
  loading: boolean;
  payload: ResearchLensSnapshot | null;
  priceSeries: PriceSeriesPoint[];
  priceSeriesError: boolean;
  priceSeriesLoading: boolean;
  tradeMarkers: ResearchTradeMarker[];
  referencePrice?: number | null;
  showValuationAssumptions?: boolean;
  ticker: string;
  view: ResearchView;
}) {
  if (loading) return <LensSkeleton view={view} />;
  if (error || !payload) {
    return (
      <Alert
        color="red"
        icon={<Info size={18} />}
        title={<Localized zh="当前页面加载失败" en="This view failed to load" />}
      >
        <Localized
          zh="其他页面仍可使用。稍后返回此页即可重试。"
          en="Other views are still available. Return here later to retry."
        />
      </Alert>
    );
  }
  const technical = payload.technical ?? null;
  const valuation = payload.valuation ?? null;
  const option = payload.options ?? null;
  return (
    <Stack className="tm-lens-enter" gap="xl">
      {view === "overview" ? (
        <OverviewLens
          payload={payload}
          priceSeries={priceSeries}
          priceSeriesError={priceSeriesError}
          priceSeriesLoading={priceSeriesLoading}
          tradeMarkers={tradeMarkers}
          technical={technical}
          valuation={valuation}
        />
      ) : null}
      {view === "technical" ? (
        <TechnicalLens
          priceSeries={priceSeries}
          priceSeriesError={priceSeriesError}
          priceSeriesLoading={priceSeriesLoading}
          technical={technical}
          ticker={ticker}
          tradeMarkers={tradeMarkers}
        />
      ) : null}
      {view === "valuation" ? (
        <Stack gap="xl">
          <ValuationLens valuation={valuation} />
          {showValuationAssumptions ? (
            <ValuationAssumptionsPanel ticker={ticker} />
          ) : null}
        </Stack>
      ) : null}
      {view === "fundamentals" ? (
        <FundamentalsLens
          financials={payload.financials}
          fundamentals={payload.fundamentals}
        />
      ) : null}
      {view === "analyst" ? (
        payload.analyst ? (
          <AnalystView
            analyst={payload.analyst}
            currency={technical?.currency ?? valuation?.currency ?? "USD"}
            priceHistory={priceSeries}
            referencePrice={referencePrice}
          />
        ) : <Missing />
      ) : null}
      {view === "options" ? <OptionsLens option={option} /> : null}
      {view === "ledger" ? <LedgerLens payload={payload} /> : null}
    </Stack>
  );
}

function LensSkeleton({ view }: { view: ResearchView }) {
  return (
    <Stack aria-busy="true" aria-live="polite" gap="lg" role="status">
      <Group justify="space-between">
        <Skeleton h={30} w={view === "fundamentals" ? 260 : 180} />
        <Skeleton h={28} w={110} />
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton h={96} key={index} radius="lg" />
        ))}
      </SimpleGrid>
      <Skeleton h={view === "overview" || view === "technical" ? 440 : 320} radius="lg" />
    </Stack>
  );
}

function OverviewLens({
  payload,
  priceSeries,
  priceSeriesError,
  priceSeriesLoading,
  technical,
  tradeMarkers,
  valuation,
}: {
  payload: ResearchLensSnapshot;
  priceSeries: PriceSeriesPoint[];
  priceSeriesError: boolean;
  priceSeriesLoading: boolean;
  technical: TechnicalRow | null;
  tradeMarkers: ResearchTradeMarker[];
  valuation: ValuationRow | null;
}) {
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, lg: 4 }}>
        <Metric
          label={<Localized zh="技术评分" en="Technical score" />}
          value={technical ? `${technical.score}/100` : "—"}
        />
        <Metric
          label={<Localized zh="技术状态" en="Technical state" />}
          value={technical?.state ?? "—"}
        />
        <Metric
          label="EV 5Y"
          value={valuation?.ev5Upside == null ? "—" : deltaPct(valuation.ev5Upside)}
        />
        <Metric
          label={<Localized zh="组合敞口" en="Portfolio exposure" />}
          value={payload.portfolioImpact
            ? gbp(payload.portfolioImpact.exposureValueGbp, 0)
            : "—"}
        />
      </SimpleGrid>
      <Grid align="stretch">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper h="100%" p="lg" withBorder>
            <PriceSeriesPanel
              compact
              currency={technical?.currency ?? valuation?.currency ?? "USD"}
              defaultRange="1m"
              error={priceSeriesError}
              loading={priceSeriesLoading}
              points={priceSeries}
              showControls={false}
              ticker={payload.ticker}
              tradeMarkers={tradeMarkers}
            />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Stack gap="md" h="100%">
            <Paper p="lg" withBorder>
              <Stack gap="lg">
                <Metric
                  label="RSI 14"
                  value={technical?.rsi?.toFixed(1) ?? "—"}
                />
                <Metric
                  label={<Localized zh="距 52 周高点" en="From 52-week high" />}
                  value={technical?.drawdown52w == null
                    ? "—"
                    : deltaPct(technical.drawdown52w)}
                />
                <Metric
                  label={<Localized zh="估值结论" en="Valuation verdict" />}
                  value={valuation?.verdict ?? "—"}
                />
              </Stack>
            </Paper>
            {payload.latestEvent ? (
              <Alert
                color="blue"
                icon={<Info size={18} />}
                title={payload.latestEvent.title}
              >
                {payload.latestEvent.summary ?? payload.latestEvent.asOf}
              </Alert>
            ) : null}
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function TechnicalLens({
  priceSeries,
  priceSeriesError,
  priceSeriesLoading,
  technical,
  ticker,
  tradeMarkers,
}: {
  priceSeries: PriceSeriesPoint[];
  priceSeriesError: boolean;
  priceSeriesLoading: boolean;
  technical: TechnicalRow | null;
  ticker: string;
  tradeMarkers: ResearchTradeMarker[];
}) {
  if (!technical) return <Missing />;
  return (
    <Paper p="lg" withBorder>
      <Stack gap="lg">
        {!technical.historyCoverage.complete ? (
          <Alert
            color="yellow"
            icon={<Info size={18} />}
            title={<Localized zh="历史数据不完整" en="Incomplete price history" />}
          >
            {technical.historyCoverage.availableSessions} sessions ·{" "}
            {technical.historyCoverage.firstSession}–
            {technical.historyCoverage.lastSession}
          </Alert>
        ) : null}
        <Group align="flex-end" justify="space-between" wrap="wrap">
          <div>
            <Title order={2} size="h3">
              {ticker} <Localized zh="技术状态" en="technical state" />
            </Title>
            <Text c="dimmed">{technical.state}</Text>
          </div>
          <Stack gap={6} w={{ base: "100%", sm: 260 }}>
            <Group justify="space-between">
              <Text c="dimmed" size="xs">
                <Localized zh="技术评分" en="Technical score" />
              </Text>
              <Text fw={800}>{technical.score}/100</Text>
            </Group>
            <Progress
              aria-label={typeof technical.score === "number"
                ? `${technical.score} / 100`
                : undefined}
              color={technical.score >= 60
                ? "green"
                : technical.score >= 40
                  ? "yellow"
                  : "red"}
              value={technical.score}
            />
          </Stack>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg" verticalSpacing="md">
          <Metric label="RSI 14" value={technical.rsi?.toFixed(2) ?? "—"} />
          <Metric
            label="MACD hist."
            value={technical.macdHistogram?.toFixed(2) ?? "—"}
          />
          <Metric
            label={<Localized zh="20 日涨跌" en="20D return" />}
            value={technical.return20d == null ? "—" : deltaPct(technical.return20d)}
          />
          <Metric
            label={<Localized zh="63 日涨跌" en="63D return" />}
            value={technical.return63d == null ? "—" : deltaPct(technical.return63d)}
          />
          <Metric
            label={<Localized zh="ATR / 现价" en="ATR / price" />}
            value={technical.atrPct == null ? "—" : pct(technical.atrPct)}
          />
          <Metric
            label="SMA 20"
            value={technical.sma20 == null
              ? "—"
              : money(technical.sma20, technical.currency, 2)}
          />
          <Metric
            label="SMA 50"
            value={technical.sma50 == null
              ? "—"
              : money(technical.sma50, technical.currency, 2)}
          />
          <Metric
            label="SMA 200"
            value={technical.sma200 == null
              ? "—"
              : money(technical.sma200, technical.currency, 2)}
          />
        </SimpleGrid>
        <Divider />
        <PriceSeriesPanel
          currency={technical.currency}
          error={priceSeriesError}
          loading={priceSeriesLoading}
          panHistory
          points={priceSeries}
          ticker={ticker}
          tradeMarkers={tradeMarkers}
        />
        <Divider />
        <Stack gap="xs">
          <Text fw={700}>
            <Localized zh="当前技术信号" en="Current technical signals" />
          </Text>
          <List spacing="xs">
            {technical.signals.map((signal) => (
              <List.Item key={signal}>{signal}</List.Item>
            ))}
          </List>
        </Stack>
      </Stack>
    </Paper>
  );
}

function PriceSeriesPanel({
  compact = false,
  currency,
  defaultRange = "1y",
  error,
  loading,
  panHistory = false,
  points,
  showControls = true,
  ticker,
  tradeMarkers,
}: {
  compact?: boolean;
  currency: string;
  defaultRange?: "1m" | "3m" | "6m" | "1y" | "2y" | "max";
  error: boolean;
  loading: boolean;
  panHistory?: boolean;
  points: PriceSeriesPoint[];
  showControls?: boolean;
  ticker: string;
  tradeMarkers: ResearchTradeMarker[];
}) {
  if (loading) {
    return (
      <Paper aria-busy="true" p="lg" withBorder>
        <Stack gap="md">
          <Group justify="space-between">
            <Skeleton h={28} w={180} />
            <Skeleton h={30} w={260} />
          </Group>
          <Skeleton h={compact ? 248 : 390} radius="md" />
        </Stack>
      </Paper>
    );
  }
  if (error) {
    return (
      <Alert
        color="red"
        icon={<Info size={18} />}
        title={<Localized zh="价格历史加载失败" en="Price history unavailable" />}
      >
        <Localized
          zh="其他研究数据仍可使用；请稍后重试当前标的。"
          en="The remaining research data is still available; retry this ticker later."
        />
      </Alert>
    );
  }
  return (
    <PriceChart
      compact={compact}
      currency={currency}
      defaultRange={defaultRange}
      panHistory={panHistory}
      points={points}
      showControls={showControls}
      ticker={ticker}
      tradeMarkers={tradeMarkers}
    />
  );
}

function ValuationLens({ valuation }: { valuation: ValuationRow | null }) {
  if (!valuation) return <Missing />;
  const position = valuationRangePosition(valuation.verdict);
  return (
    <Stack gap="xl">
      <Group justify="space-between">
        <div>
          <Title order={2}>
            {valuation.ticker} <Localized zh="估值结论" en="valuation" />
          </Title>
          <Text c="dimmed">
            <Localized zh="现金流估值范围，不代表目标价。" en="Cash-flow valuation range, not a price target." />
          </Text>
        </div>
        <Badge color={position.color} size="lg" variant="light">{position.label}</Badge>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric
          label={<Localized zh="模型现价输入" en="Model spot input" />}
          value={money(valuation.spot, valuation.currency, 2)}
        />
        <Metric
          label={<Localized zh="5 年情景基准" en="5Y scenario base" />}
          value={valuation.ev5 == null
            ? "—"
            : money(valuation.ev5, valuation.currency, 2)}
        />
        <Metric
          label={<Localized zh="10 年情景基准" en="10Y scenario base" />}
          value={valuation.ev10 == null
            ? "—"
            : money(valuation.ev10, valuation.currency, 2)}
        />
        <Metric
          label={<Localized zh="分析师市场参照" en="Analyst market reference" />}
          value={valuation.analystMedian == null
            ? "—"
            : money(valuation.analystMedian, valuation.currency, 2)}
        />
        <Metric
          label="Trailing P/E"
          value={valuation.trailingPe == null ? "—" : ratio(valuation.trailingPe)}
        />
        <Metric
          label="Forward P/E"
          value={valuation.forwardPe == null ? "—" : ratio(valuation.forwardPe)}
        />
        <Metric
          label="P/S"
          value={valuation.priceToSales == null
            ? "—"
            : ratio(valuation.priceToSales)}
        />
        <Metric
          label="EV/EBITDA"
          value={valuation.enterpriseToEbitda == null
            ? "—"
            : ratio(valuation.enterpriseToEbitda)}
        />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <ValuationPriceChart valuation={valuation} />
        <ValuationSensitivityChart valuation={valuation} />
      </SimpleGrid>
      <Table className="tm-research-table-desktop">
        <Table.Thead>
          <Table.Tr>
            <Table.Th><Localized zh="情景" en="Scenario" /></Table.Th>
            <Table.Th ta="right"><Localized zh="价值" en="Value" /></Table.Th>
            <Table.Th ta="right">Revenue CAGR</Table.Th>
            <Table.Th ta="right">FCF margin</Table.Th>
            <Table.Th ta="right"><Localized zh="折现率" en="Discount rate" /></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {Object.entries(valuation.scenarios).map(([name, row]) => (
            <Table.Tr key={name}>
              <Table.Td fw={700}>{scenarioLabel(name)}</Table.Td>
              <Table.Td ta="right">
                {row.value == null
                  ? "—"
                  : money(row.value, valuation.currency, 2)}
              </Table.Td>
              <Table.Td ta="right">
                {row.revenueCagr == null ? "—" : deltaPct(row.revenueCagr)}
              </Table.Td>
              <Table.Td ta="right">
                {row.targetFcfMargin == null ? "—" : pct(row.targetFcfMargin)}
              </Table.Td>
              <Table.Td ta="right">
                {row.discountRate == null ? "—" : pct(row.discountRate)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <SimpleGrid className="tm-research-table-mobile" cols={1}>
        {Object.entries(valuation.scenarios).map(([name, row]) => (
          <Paper key={name} p="md" withBorder>
            <Group justify="space-between">
              <Text fw={800}>{scenarioLabel(name)}</Text>
              <Text fw={800}>{row.value == null ? "—" : money(row.value, valuation.currency, 2)}</Text>
            </Group>
            <SimpleGrid cols={3} mt="sm">
              <Metric label={<Localized zh="营收增速" en="Revenue CAGR" />} value={row.revenueCagr == null ? "—" : deltaPct(row.revenueCagr)} />
              <Metric label={<Localized zh="现金流率" en="FCF margin" />} value={row.targetFcfMargin == null ? "—" : pct(row.targetFcfMargin)} />
              <Metric label={<Localized zh="折现率" en="Discount rate" />} value={row.discountRate == null ? "—" : pct(row.discountRate)} />
            </SimpleGrid>
          </Paper>
        ))}
      </SimpleGrid>
      {valuation.modelWarnings.length ? (
        <Accordion variant="contained">
          <Accordion.Item value="valuation-boundaries">
            <Accordion.Control icon={<Info size={18} />}>
              <Group gap="sm">
                <Text fw={700}><Localized zh="估值假设" en="Valuation assumptions" /></Text>
                <Badge color="gray" variant="light">{valuation.modelWarnings.length}</Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <List c="dimmed" spacing="xs" size="sm">
                {valuation.modelWarnings.map((warning) => (
                  <List.Item key={warning}>{warning}</List.Item>
                ))}
              </List>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      ) : null}
    </Stack>
  );
}

function valuationRangePosition(value: string): { color: string; label: React.ReactNode } {
  if (value === "below-model-range") {
    return { color: "green", label: <Localized zh="低于模型区间" en="Below model range" /> };
  }
  if (value === "within-model-range") {
    return { color: "blue", label: <Localized zh="位于模型区间" en="Within model range" /> };
  }
  if (value === "above-model-range") {
    return { color: "gray", label: <Localized zh="高于模型区间" en="Above model range" /> };
  }
  return { color: "gray", label: <Localized zh="暂无模型估值" en="No model valuation" /> };
}

function scenarioLabel(value: string) {
  if (value === "bear") return <Localized zh="悲观" en="Bear" />;
  if (value === "base") return <Localized zh="基准" en="Base" />;
  if (value === "bull") return <Localized zh="乐观" en="Bull" />;
  return value;
}

function OptionsLens({ option }: { option: OptionSnapshot | null }) {
  if (!option) return <Missing />;
  return <OptionsChainView option={option} />;
}

function LedgerLens({ payload }: { payload: ResearchLensSnapshot }) {
  const events = payload.events ?? [];
  const alerts = payload.alerts ?? [];
  return (
    <Stack>
      <Title order={2}><Localized zh="研究账本" en="Research ledger" /></Title>
      {alerts.map((alert) => (
        <Alert
          color={alert.severity === "critical"
            ? "red"
            : alert.severity === "warning"
              ? "yellow"
              : "blue"}
          key={alert.alertId}
          title={alert.title}
        >
          {alert.message}
        </Alert>
      ))}
      <Table className="tm-research-table-desktop">
        <Table.Thead>
          <Table.Tr>
            <Table.Th><Localized zh="日期" en="Date" /></Table.Th>
            <Table.Th><Localized zh="事件" en="Event" /></Table.Th>
            <Table.Th><Localized zh="摘要" en="Summary" /></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={`${event.eventType}-${event.asOf}`}>
              <Table.Td>{shortDate(event.asOf)}</Table.Td>
              <Table.Td>{event.title}</Table.Td>
              <Table.Td>{event.summary ?? "—"}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Stack className="tm-research-table-mobile" gap="xs">
        {events.map((event) => (
          <Paper key={`${event.eventType}-${event.asOf}`} p="md" withBorder>
            <Text c="dimmed" size="xs">{shortDate(event.asOf)}</Text>
            <Text fw={700}>{event.title}</Text>
            {event.summary ? <Text mt={4} size="sm">{event.summary}</Text> : null}
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}

function Metric({
  label,
  value,
}: {
  label: React.ReactNode;
  value: string;
}) {
  return (
    <div>
      <Text c="dimmed" size="xs">{label}</Text>
      <Text fw={700} size="lg">{value}</Text>
    </div>
  );
}

function Missing() {
  return (
    <Alert
      color="gray"
      icon={<Info size={18} />}
      title={<Localized zh="暂无可验证数据" en="No verified data" />}
    >
      <Localized
        zh="更新该标的数据后再查看。"
        en="Update this ticker's data, then return."
      />
    </Alert>
  );
}
