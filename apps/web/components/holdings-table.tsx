"use client";

import {
  ActionIcon,
  Badge,
  Button,
  CloseButton,
  Collapse,
  Group,
  Paper,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { CompanyMark } from "@/components/company-mark";
import { useLocale } from "@/components/locale-provider";
import { gbp, money, pct, unsignedPct } from "@/lib/format";
import type { Holding } from "@/lib/types";

export type HoldingSort = "value" | "pnl" | "allocation" | "ticker";
export const holdingSorts: HoldingSort[] = ["value", "pnl", "allocation", "ticker"];

const MOBILE_PREVIEW_COUNT = 6;

function nativeMoney(value: number, currency: string) {
  try {
    return money(value, currency, 2);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function HoldingsTable({
  holdings,
  onQueryChange,
  onSortChange,
  query,
  sort,
}: {
  holdings: Holding[];
  onQueryChange: (query: string) => void;
  onSortChange: (sort: HoldingSort) => void;
  query: string;
  sort: HoldingSort;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [showAllMobile, setShowAllMobile] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(Boolean(query));
  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return holdings
      .filter((holding) => !normalized
        || holding.ticker.toLowerCase().includes(normalized)
        || holding.name.toLowerCase().includes(normalized))
      .sort((left, right) => {
        if (sort === "ticker") return left.ticker.localeCompare(right.ticker);
        if (sort === "pnl") return right.pnlGbp - left.pnlGbp;
        if (sort === "allocation") return right.allocationPct - left.allocationPct;
        return right.currentValueGbp - left.currentValueGbp;
      });
  }, [holdings, query, sort]);
  const mobileRows = showAllMobile || query ? rows : rows.slice(0, MOBILE_PREVIEW_COUNT);

  const sortOptions = [
    { label: zh ? "市值：高到低" : "Value: high to low", value: "value" },
    { label: zh ? "浮动盈亏：高到低" : "P&L: high to low", value: "pnl" },
    { label: zh ? "组合占比：高到低" : "Allocation: high to low", value: "allocation" },
    { label: zh ? "Ticker：A–Z" : "Ticker: A–Z", value: "ticker" },
  ];

  return (
    <Stack gap="md">
      <Group align="flex-end" justify="space-between" visibleFrom="sm" wrap="wrap">
        <div>
          <Title order={2} size="h3">{zh ? "券商持仓" : "Broker positions"}</Title>
          <Text c="dimmed" mt={2} size="sm">
            {query
              ? zh ? `${rows.length} 个匹配结果 · 当前账户共 ${holdings.length} 个持仓` : `${rows.length} matches · ${holdings.length} positions in this account`
              : zh ? `${holdings.length} 个持仓` : `${holdings.length} positions`}
          </Text>
        </div>
        <Group align="flex-end" flex={1} justify="flex-end" wrap="wrap">
          <Select
            allowDeselect={false}
            aria-label={zh ? "持仓排序" : "Sort positions"}
            data={sortOptions}
            label={zh ? "排序" : "Sort"}
            onChange={(value) => onSortChange(value as HoldingSort)}
            value={sort}
            w={{ base: "100%", sm: 210 }}
          />
          <TextInput
            aria-label={zh ? "搜索持仓" : "Search holdings"}
            label={zh ? "搜索" : "Search"}
            leftSection={<MagnifyingGlass aria-hidden="true" size={17} />}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={zh ? "Ticker 或公司名称" : "Ticker or company name"}
            rightSection={query ? (
              <CloseButton
                aria-label={zh ? "清除持仓搜索" : "Clear holdings search"}
                onClick={() => onQueryChange("")}
                size="sm"
              />
            ) : null}
            rightSectionPointerEvents="all"
            value={query}
            w={{ base: "100%", sm: 280 }}
          />
        </Group>
      </Group>

      <Stack gap="sm" hiddenFrom="sm">
        <Group align="center" justify="space-between" wrap="nowrap">
          <div>
            <Title order={2} size="h3">{zh ? "券商持仓" : "Broker positions"}</Title>
            <Text c="dimmed" mt={2} size="sm">
              {query
                ? zh ? `${rows.length} 个匹配结果 · 共 ${holdings.length} 个持仓` : `${rows.length} matches · ${holdings.length} positions`
                : zh ? `${holdings.length} 个持仓` : `${holdings.length} positions`}
            </Text>
          </div>
          <Group gap="xs" wrap="nowrap">
            <Select
              allowDeselect={false}
              aria-label={zh ? "持仓排序" : "Sort positions"}
              data={sortOptions}
              onChange={(value) => onSortChange(value as HoldingSort)}
              size="sm"
              value={sort}
              w={150}
            />
            <ActionIcon
              aria-expanded={mobileSearchOpen}
              aria-label={zh ? "搜索持仓" : "Search positions"}
              onClick={() => setMobileSearchOpen((current) => !current)}
              size="lg"
              variant={mobileSearchOpen ? "filled" : "light"}
            >
              <MagnifyingGlass aria-hidden="true" size={18} />
            </ActionIcon>
          </Group>
        </Group>
        <Collapse expanded={mobileSearchOpen}>
          <TextInput
            aria-label={zh ? "搜索持仓" : "Search holdings"}
            leftSection={<MagnifyingGlass aria-hidden="true" size={17} />}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={zh ? "Ticker 或公司名称" : "Ticker or company name"}
            rightSection={query ? (
              <CloseButton
                aria-label={zh ? "清除持仓搜索" : "Clear holdings search"}
                onClick={() => onQueryChange("")}
                size="sm"
              />
            ) : null}
            rightSectionPointerEvents="all"
            value={query}
          />
        </Collapse>
      </Stack>

      {rows.length ? (
        <>
          <Stack aria-label={zh ? "持仓列表" : "Holdings list"} gap="xs" hiddenFrom="sm">
            {mobileRows.map((holding) => (
              <Paper key={`${holding.account}-${holding.ticker}`} p="sm" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm" miw={0} wrap="nowrap">
                      <CompanyMark name={holding.name} size={38} ticker={holding.ticker} />
                      <div style={{ minWidth: 0 }}>
                        <Group gap="xs" wrap="nowrap">
                          <Text fw={700}>{holding.ticker}</Text>
                          <Badge color={holding.account === "A" ? "orange" : "cyan"} size="xs" variant="light">
                            {holding.account === "A" ? "Invest" : "ISA"}
                          </Badge>
                        </Group>
                        <Text c="dimmed" lineClamp={2} size="xs">{holding.name}</Text>
                      </div>
                    </Group>
                    <Text fw={800}>{gbp(holding.currentValueGbp, 0)}</Text>
                  </Group>
                  <Group justify="space-between" wrap="wrap">
                    <div>
                      <Text c="dimmed" size="xs">{zh ? "摊薄成本 / 股" : "Diluted cost / share"}</Text>
                      <Text fw={700} size="sm">
                        {holding.dilutedCostPerShareNative == null
                          ? "—"
                          : nativeMoney(holding.dilutedCostPerShareNative, holding.dilutedCostCurrency)}
                      </Text>
                    </div>
                    <div>
                      <Text c="dimmed" size="xs">{zh ? "现价" : "Current price"}</Text>
                      <Text fw={700} size="sm">{nativeMoney(holding.currentPrice, holding.priceCurrency)}</Text>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <Text c={holding.pnlGbp >= 0 ? "green" : "red"} fw={700} size="sm">{gbp(holding.pnlGbp, 2)}</Text>
                      <Text c={holding.pnlGbp >= 0 ? "green" : "red"} size="xs">{pct(holding.pnlPct)}</Text>
                    </div>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Progress aria-hidden="true" color="brand" flex={1} size="sm" value={Math.min(100, holding.allocationPct * 100)} />
                    <Text fw={700} size="xs">{unsignedPct(holding.allocationPct)}</Text>
                  </Group>
                </Stack>
              </Paper>
            ))}
            {!showAllMobile && !query && rows.length > MOBILE_PREVIEW_COUNT ? (
              <Button onClick={() => setShowAllMobile(true)} variant="subtle">
                {zh ? `显示全部 ${rows.length} 个持仓` : `Show all ${rows.length} positions`}
              </Button>
            ) : null}
          </Stack>

          <Table.ScrollContainer
            minWidth={1050}
            visibleFrom="sm"
            scrollAreaProps={{
              viewportProps: { "aria-label": zh ? "持仓明细表" : "Holdings table", tabIndex: 0 },
            }}
          >
            <Table highlightOnHover stickyHeader verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{zh ? "标的" : "Instrument"}</Table.Th>
                  <Table.Th>{zh ? "账户" : "Account"}</Table.Th>
                  <Table.Th ta="right">{zh ? "数量" : "Quantity"}</Table.Th>
                  <Table.Th ta="right">{zh ? "市值" : "Value"}</Table.Th>
                  <Table.Th ta="right">{zh ? "摊薄成本/股" : "Diluted cost/share"}</Table.Th>
                  <Table.Th ta="right">{zh ? "现价" : "Current price"}</Table.Th>
                  <Table.Th ta="right">{zh ? "浮动盈亏" : "Unrealized P&L"}</Table.Th>
                  <Table.Th ta="right">{zh ? "组合占比" : "Allocation"}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((holding) => (
                  <Table.Tr key={`${holding.account}-${holding.ticker}`}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <CompanyMark name={holding.name} ticker={holding.ticker} />
                        <div>
                          <Text fw={700}>{holding.ticker}</Text>
                          <Text c="dimmed" lineClamp={1} size="xs">{holding.name}</Text>
                        </div>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={holding.account === "A" ? "orange" : "cyan"} variant="light">
                        {holding.account === "A" ? "Invest" : "ISA"}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right">{holding.quantity.toLocaleString("en-GB", { maximumFractionDigits: 4 })}</Table.Td>
                    <Table.Td fw={700} ta="right">{gbp(holding.currentValueGbp, 2)}</Table.Td>
                    <Table.Td ta="right">
                      <Text fw={700} size="sm">
                        {holding.dilutedCostPerShareNative == null
                          ? "—"
                          : nativeMoney(holding.dilutedCostPerShareNative, holding.dilutedCostCurrency)}
                      </Text>
                      {holding.dilutedCostPerShareGbp == null ? null : (
                        <Text c="dimmed" size="xs">
                          GBP {gbp(holding.dilutedCostPerShareGbp, 2)}
                          {holding.fxImpactGbp == null ? "" : ` · FX ${gbp(holding.fxImpactGbp, 2)}`}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fw={700} size="sm">{nativeMoney(holding.currentPrice, holding.priceCurrency)}</Text>
                      {holding.quantity > 0 ? (
                        <Text c="dimmed" size="xs">{zh ? "折合" : "≈"} {gbp(holding.currentValueGbp / holding.quantity, 2)}</Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td c={holding.pnlGbp >= 0 ? "green" : "red"} ta="right">
                      <Text fw={700}>{gbp(holding.pnlGbp, 2)}</Text>
                      <Text size="xs">{pct(holding.pnlPct)}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Group justify="flex-end" wrap="nowrap">
                        <Progress aria-hidden="true" color="brand" size="sm" value={Math.min(100, holding.allocationPct * 100)} w={72} />
                        <Text fw={700} size="sm">{unsignedPct(holding.allocationPct)}</Text>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      ) : (
        <Stack align="center" gap="xs" py="xl">
          <Title order={3} size="h4">{zh ? "没有匹配的持仓" : "No matching holdings"}</Title>
          <Text c="dimmed" ta="center">
            {zh ? "清除搜索，或选择其他账户。" : "Clear the search or choose another account."}
          </Text>
          {query ? <Button onClick={() => onQueryChange("")} variant="light">{zh ? "清除搜索" : "Clear search"}</Button> : null}
        </Stack>
      )}
    </Stack>
  );
}
