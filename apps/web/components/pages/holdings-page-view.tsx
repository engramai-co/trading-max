"use client";

import {
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  HoldingsTable,
  type HoldingSort,
  holdingSorts,
} from "@/components/holdings-table";
import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { Localized, useLocale } from "@/components/locale-provider";
import { LookthroughPanel } from "@/components/lookthrough-panel";
import { PageHeader } from "@/components/page-header";
import { ViewSwitch } from "@/components/view-switch";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { gbp } from "@/lib/format";
import type { AccountCode } from "@/lib/types";
import { replaceUrlState } from "@/lib/url-state";
import { formatDateTime } from "@/ui/formatters";

type HoldingsAccount = "all" | Extract<AccountCode, "A" | "B">;
type HoldingsView = "positions" | "lookthrough";

export function HoldingsPageView({ initialAccount, initialQuery, view }: {
  initialAccount: HoldingsAccount;
  initialQuery: string;
  view: HoldingsView;
}) {
  const params = useSearchParams();
  const { locale } = useLocale();
  const [activeView, setActiveView] = useState(view);
  const [account, setAccount] = useState<HoldingsAccount>(initialAccount);
  const [positionsQuery, setPositionsQuery] = useState(initialQuery);
  const requestedSort = params.get("positionSort") as HoldingSort | null;
  const [positionsSort, setPositionsSort] = useState<HoldingSort>(
    holdingSorts.includes(requestedSort as HoldingSort) ? requestedSort! : "value",
  );
  const positionsLens = useDashboardLens("holdings-positions");
  const lookthroughLens = useDashboardLens(
    "holdings-lookthrough",
    undefined,
    activeView === "lookthrough",
  );
  const positions = positionsLens.data;
  const scopedHoldings = useMemo(
    () => (positions?.holdings ?? []).filter(
      (holding) => account === "all" || holding.account === account,
    ),
    [account, positions?.holdings],
  );
  const selectedAccount = positions?.accounts?.find((item) => item.code === account);
  const scopedInvested = scopedHoldings.reduce((sum, holding) => sum + holding.currentValueGbp, 0);
  const scopedPnl = scopedHoldings.reduce((sum, holding) => sum + holding.pnlGbp, 0);
  const truth = positions
    ? account === "all"
      ? {
          asOf: positions.brokerAsOf,
          cash: positions.totalCashGbp ?? 0,
          invested: positions.totalInvestedGbp ?? scopedInvested,
          pnl: positions.totalUnrealizedPnlGbp ?? scopedPnl,
          total: positions.totalValueGbp ?? scopedInvested,
        }
      : {
          asOf: selectedAccount?.asOf ?? positions.brokerAsOf,
          cash: selectedAccount?.cashGbp ?? 0,
          invested: selectedAccount?.investedGbp ?? scopedInvested,
          pnl: selectedAccount?.unrealizedPnlGbp ?? scopedPnl,
          total: selectedAccount?.totalValueGbp ?? scopedInvested,
        }
    : null;
  const profitable = scopedHoldings.filter((holding) => holding.pnlGbp > 0).length;
  const lookthrough = lookthroughLens.data?.lookthrough ?? null;

  function selectView(next: HoldingsView) {
    setActiveView(next);
    replaceUrlState({ view: next === "positions" ? null : next });
  }

  function selectAccount(next: HoldingsAccount) {
    setAccount(next);
    replaceUrlState({ account: next === "all" ? null : next });
  }

  function updatePositionsQuery(next: string) {
    setPositionsQuery(next);
    replaceUrlState({ q: next.trim() || null });
  }

  function updatePositionsSort(next: HoldingSort) {
    setPositionsSort(next);
    replaceUrlState({ positionSort: next === "value" ? null : next });
  }

  return (
    <Stack gap="xl">
      <PageHeader
        title={<Localized zh="持仓" en="Holdings" />}
        description={
          <Localized
            zh="查看各账户的持仓、盈亏和 ETF 底层配置。"
            en="See positions, P&L, and ETF holdings across your accounts."
          />
        }
      />

      <ViewSwitch
        data={[
          { label: locale === "zh" ? "券商持仓" : "Broker positions", value: "positions" },
          { label: locale === "zh" ? "ETF 穿透" : "ETF look-through", value: "lookthrough" },
        ]}
        label={locale === "zh" ? "持仓视图" : "Holdings view"}
        onChange={(next) => selectView(next as HoldingsView)}
        value={activeView}
      />

      {activeView === "positions" ? (
        <>
          {positionsLens.isPending ? <LensSkeleton cards={1} height={190} /> : null}
          {positionsLens.isError ? <LensError retry={() => void positionsLens.refetch()} /> : null}
          {truth ? (
            <PortfolioTruth
              account={account}
              holdingsCount={scopedHoldings.length}
              locale={locale}
              onAccountChange={selectAccount}
              profitable={profitable}
              truth={truth}
            />
          ) : null}
          <Paper component="section" p={{ base: "md", sm: "lg" }} withBorder>
            {positions ? (
              <LensContent>
                <HoldingsTable
                  holdings={scopedHoldings}
                  onQueryChange={updatePositionsQuery}
                  onSortChange={updatePositionsSort}
                  query={positionsQuery}
                  sort={positionsSort}
                />
              </LensContent>
            ) : (
              <LensSkeleton cards={1} height={360} />
            )}
          </Paper>
        </>
      ) : (
        <>
          {lookthroughLens.isPending ? (
            <Paper p={{ base: "md", sm: "lg" }} withBorder>
              <Stack gap="sm">
                <Text fw={700}>{locale === "zh" ? "正在读取 ETF 持仓" : "Loading ETF holdings"}</Text>
                <Text c="dimmed" size="sm">
                  {locale === "zh"
                    ? "正在汇总基金成分、国家和行业。"
                    : "Loading fund constituents, countries, and sectors."}
                </Text>
                <LensSkeleton cards={2} height={260} />
              </Stack>
            </Paper>
          ) : null}
          {lookthroughLens.isError ? <LensError retry={() => void lookthroughLens.refetch()} /> : null}
          {lookthrough ? <LensContent><LookthroughPanel data={lookthrough} /></LensContent> : null}
        </>
      )}
    </Stack>
  );
}

function PortfolioTruth({
  account,
  holdingsCount,
  locale,
  onAccountChange,
  profitable,
  truth,
}: {
  account: HoldingsAccount;
  holdingsCount: number;
  locale: "zh" | "en";
  onAccountChange: (account: HoldingsAccount) => void;
  profitable: number;
  truth: { asOf: string; cash: number; invested: number; pnl: number; total: number };
}) {
  const { timeZone } = useLocale();
  const parts = [
    { label: locale === "zh" ? "已投资资产" : "Invested assets", value: truth.invested },
    { label: locale === "zh" ? "现金" : "Cash", value: truth.cash },
    { label: locale === "zh" ? "浮动盈亏" : "Unrealized P&L", tone: truth.pnl >= 0 ? "positive" : "negative", value: truth.pnl },
  ];
  return (
    <Paper className="tm-holdings-truth" p={{ base: "md", sm: "lg" }} withBorder>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
        <Stack gap="sm">
          <Group align="flex-start" justify="space-between" wrap="wrap">
            <div>
              <Text c="dimmed" fw={700} size="xs">{locale === "zh" ? "当前组合价值" : "Current portfolio value"}</Text>
              <Title className="tm-holdings-total" order={2}>{gbp(truth.total, 2)}</Title>
            </div>
            <Select
              allowDeselect={false}
              aria-label={locale === "zh" ? "选择账户" : "Choose account"}
              data={[
                { label: locale === "zh" ? "全部账户" : "All accounts", value: "all" },
                { label: "Invest", value: "A" },
                { label: "ISA", value: "B" },
              ]}
              onChange={(next) => next && onAccountChange(next as HoldingsAccount)}
              size="sm"
              value={account}
              w={{ base: "100%", sm: 160 }}
            />
          </Group>
          <div>
            <Text c="dimmed" size="xs">
              {locale === "zh" ? "券商数据更新至" : "Broker data updated"} {formatDateTime(truth.asOf, locale, timeZone)}
            </Text>
          </div>
        </Stack>
        <Stack gap="md" justify="center">
          <SimpleGrid cols={{ base: 2, sm: 3 }}>
            {parts.map((part) => (
              <div key={part.label}>
                <Text c="dimmed" size="xs">{part.label}</Text>
                <Text className={part.tone ? `tm-tone-${part.tone}` : undefined} fw={750}>{gbp(part.value, 0)}</Text>
              </div>
            ))}
          </SimpleGrid>
          <Text c="dimmed" size="xs">
            {locale === "zh"
              ? `${holdingsCount} 个持仓 · ${profitable} 个当前盈利`
              : `${holdingsCount} positions · ${profitable} currently profitable`}
          </Text>
        </Stack>
      </SimpleGrid>
    </Paper>
  );
}
