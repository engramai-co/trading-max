"use client";

import {
  Accordion,
  Alert,
  Badge,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Info } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { Localized, useLocale } from "@/components/locale-provider";
import { OptionsGammaChart } from "@/components/research/options-gamma-chart";
import { money, pct, ratio } from "@/lib/format";
import type { OptionSnapshot } from "@/lib/types";
import { formatDateTime } from "@/ui/formatters";

type Contract = NonNullable<OptionSnapshot["contracts"]>[number];
type Expiry = NonNullable<OptionSnapshot["expiries"]>[number];
type StrikeRow = { call?: Contract; put?: Contract; strike: number };

export function OptionsChainView({ option }: { option: OptionSnapshot }) {
  const { locale, timeZone } = useLocale();
  const zh = locale === "zh";
  const expiries = useMemo(() => option.expiries ?? [], [option.expiries]);
  const contracts = useMemo(() => option.contracts ?? [], [option.contracts]);
  const [selectedExpiry, setSelectedExpiry] = useState(expiries[0]?.expiry ?? "");
  const effectiveExpiry = expiries.some((item) => item.expiry === selectedExpiry)
    ? selectedExpiry
    : expiries[0]?.expiry ?? "";
  const expiry = expiries.find((item) => item.expiry === effectiveExpiry) ?? expiries[0];
  const rows = useMemo(
    () => buildStrikeRows(contracts, effectiveExpiry, option.spot),
    [contracts, effectiveExpiry, option.spot],
  );
  const expiryOptions = expiries.map((item) => ({
    label: expiryLabel(item, locale),
    value: item.expiry,
  }));
  const capturedAt = option.capturedAt
    ? formatDateTime(option.capturedAt, locale, timeZone)
    : "—";

  return (
    <Stack gap="xl">
      <Stack gap="md">
        <Group align="flex-end" justify="space-between" wrap="wrap">
          <div>
            <Group gap="sm">
              <Title order={2}><Localized zh="期权链" en="Options chain" /></Title>
              <Badge color="gray" variant="light">
                <Localized zh="只读研究" en="Research only" />
              </Badge>
            </Group>
            <Text c="dimmed" size="sm">
              <Localized zh="报价与持仓截至 " en="Quotes and positioning as of " />
              {capturedAt}
            </Text>
          </div>
          <Group align="flex-end" gap="md" wrap="wrap">
            <div>
              <Text c="dimmed" mb={4} size="xs"><Localized zh="到期日" en="Expiry" /></Text>
              <Select
                aria-label={zh ? "选择期权到期日" : "Select option expiry"}
                data={expiryOptions}
                disabled={!expiryOptions.length}
                onChange={(value) => setSelectedExpiry(value ?? "")}
                size="md"
                value={effectiveExpiry || null}
                w={220}
              />
            </div>
            <div>
              <Text c="dimmed" mb={4} size="xs"><Localized zh="期权快照现价" en="Options snapshot spot" /></Text>
              <Text fw={800} size="xl">{money(option.spot, "USD", 2)}</Text>
            </div>
          </Group>
        </Group>

        <Alert color="blue" icon={<Info size={18} />} variant="light">
          <Localized
            zh={structureSummary(option, expiry, true)}
            en={structureSummary(option, expiry, false)}
          />
        </Alert>

        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="lg">
          <LevelMetric
            label={<Localized zh="Put OI 集中位" en="Put OI concentration" />}
            spot={option.spot}
            value={expiry?.putWall ?? option.putWall}
          />
          <LevelMetric
            label={<Localized zh="Call OI 集中位" en="Call OI concentration" />}
            spot={option.spot}
            value={expiry?.callWall ?? option.callWall}
          />
          <LevelMetric
            label={<Localized zh="Max-pain 估算" en="Max-pain estimate" />}
            spot={option.spot}
            value={expiry?.maxPain ?? option.maxPain}
          />
          <div>
            <Text c="dimmed" size="sm"><Localized zh="Put / Call OI" en="Put / call OI" /></Text>
            <Text fw={800} size="xl">
              {(expiry?.putCallOiRatio ?? option.putCallOiRatio) == null
                ? "—"
                : ratio(expiry?.putCallOiRatio ?? option.putCallOiRatio ?? 0)}
            </Text>
            <Text c="dimmed" size="xs">
              <Localized zh="Put OI 占 Call OI 的比例" en="Put OI as a share of call OI" />
            </Text>
          </div>
        </SimpleGrid>
      </Stack>

      {rows.length ? (
        <Stack gap="sm">
          <Group justify="space-between">
            <div>
              <Title order={3}><Localized zh="现价附近档位" en="Strikes near spot" /></Title>
            </div>
            <Badge color="blue" variant="light">
              {expiry ? expiryLabel(expiry, locale) : "—"}
            </Badge>
          </Group>

          <DesktopChain rows={rows} spot={option.spot} />
        </Stack>
      ) : (
        <Alert color="gray" icon={<Info size={18} />} variant="light">
          <Localized
            zh="当前只有到期日分布，暂无逐档买卖报价。更新研究数据后会补齐期权链。"
            en="Only the expiry distribution is currently available; per-strike bid and ask quotes are missing. Update research data to complete the chain."
          />
        </Alert>
      )}

      <Accordion variant="separated">
        <Accordion.Item value="gamma">
          <Accordion.Control>
            <Group gap="sm">
              <Text fw={700}><Localized zh="Gamma 仓位估算" en="Estimated gamma positioning" /></Text>
              <Badge color="gray" variant="light"><Localized zh="模型" en="Model" /></Badge>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="md">
              <Text c="dimmed" size="sm">
                <Localized
                  zh="根据公开 OI 和期权定价模型估算，不代表交易商实际持仓。"
                  en="Estimated from public OI and an options-pricing model; it does not represent observed dealer inventory."
                />
              </Text>
              <OptionsGammaChart option={option} />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="terms">
          <Accordion.Control>
            <Text fw={700}><Localized zh="期权术语说明" en="Options terminology" /></Text>
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
              <Term term="Bid / Ask" zh="当前最高买价与最低卖价；两者差距越小，通常越容易成交。中间价不保证能成交。" en="Highest displayed bid and lowest displayed ask. A narrower gap usually means easier execution; the midpoint is not a guaranteed fill." />
              <Term term="Volume" zh="本时段成交了多少张合约，是流量，不代表还有多少仓位。" en="Contracts traded in the stated period: activity, not outstanding positions." />
              <Term term="Open interest (OI)" zh="尚未平掉的合约数量。它不能单独告诉你市场看涨还是看跌。" en="Contracts still outstanding. OI alone does not reveal bullish or bearish intent." />
              <Term term="IV" zh="期权价格中隐含的波动幅度，不表示上涨或下跌方向，也不是确定预测。" en="Movement priced into the option, not direction and not a certain forecast." />
              <Term term="Put / Call OI" zh="所选范围内 Put OI 除以 Call OI，只描述合约构成，不等同情绪。" en="Put OI divided by call OI in scope; a positioning mix, not a sentiment verdict." />
              <Term term="Max pain" zh="按当前 OI 计算、让到期内在价值总支出最小的价位；是估算，不是目标价。" en="The settlement level that minimises aggregate intrinsic-value payout under current OI; an estimate, not a price target." />
              <Term term="Gamma / GEX" zh="Gamma 描述 Delta 随股价变化的速度；GEX 再结合 OI 估算潜在对冲敏感度。" en="Gamma measures how delta changes; GEX combines model gamma with OI to estimate potential hedge sensitivity." />
              <Term term="Call / Put wall" zh="Call 或 Put OI 最集中的价位。表示持仓集中，不等于明确的支撑或阻力。" en="The strike with concentrated call or put OI. It shows concentration, not guaranteed support or resistance." />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="boundaries">
          <Accordion.Control>
            <Text fw={700}><Localized zh="数据说明" en="Data notes" /></Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="sm"><Localized zh="• 买卖价、成交量和 OI 可能延迟；请以上方采集时间为准。" en="• Bid, ask, volume, and OI may be delayed; use the capture time shown above." /></Text>
              <Text size="sm"><Localized zh="• IV 与 Gamma 是定价模型输出，会随现价、时间和波动率变化。" en="• IV and gamma are pricing-model outputs that change with spot, time, and volatility." /></Text>
              <Text size="sm"><Localized zh="• GEX 假设 Call 为正、Put 为负，并假设交易商净卖出期权；它不是交易商库存实测。" en="• GEX signs calls positive and puts negative and assumes dealers are net short options; it is not measured inventory." /></Text>
              <Text size="sm"><Localized zh="• 墙、Gamma flip 和 Max pain 都是描述性估算，不是交易建议或价格预测。" en="• Walls, gamma flip, and max pain are descriptive estimates, not trading advice or price forecasts." /></Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function DesktopChain({ rows, spot }: { rows: StrikeRow[]; spot: number }) {
  return (
    <Table.ScrollContainer minWidth={1050}>
      <Table
        highlightOnHover
        striped={false}
        style={{ border: "1px solid var(--mantine-color-gray-3)" }}
        withColumnBorders
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th colSpan={5} ta="center"><Localized zh="Calls" en="Calls" /></Table.Th>
            <Table.Th className="tm-option-strike" rowSpan={2} ta="center"><Localized zh="行权价" en="Strike" /></Table.Th>
            <Table.Th colSpan={5} ta="center"><Localized zh="Puts" en="Puts" /></Table.Th>
          </Table.Tr>
          <Table.Tr>
            <Table.Th ta="right">OI</Table.Th><Table.Th ta="right"><Localized zh="成交" en="Vol" /></Table.Th><Table.Th ta="right">IV</Table.Th><Table.Th ta="right">Bid</Table.Th><Table.Th ta="right">Ask</Table.Th>
            <Table.Th ta="right">Bid</Table.Th><Table.Th ta="right">Ask</Table.Th><Table.Th ta="right">IV</Table.Th><Table.Th ta="right"><Localized zh="成交" en="Vol" /></Table.Th><Table.Th ta="right">OI</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => {
            const atm = isAtm(rows, row.strike, spot);
            return (
              <Table.Tr className={atm ? "tm-option-atm" : undefined} key={row.strike}>
                <ContractCells contract={row.call} />
                <Table.Td className="tm-option-strike" fw={800} ta="center">
                  {money(row.strike, "USD", 0)}
                  {atm ? <Badge color="blue" ml={6} size="xs" variant="light">ATM</Badge> : null}
                </Table.Td>
                <ContractCells contract={row.put} reverse />
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function ContractCells({ contract, reverse = false }: { contract?: Contract; reverse?: boolean }) {
  const values = reverse
    ? [premium(contract?.bid), premium(contract?.ask), iv(contract?.impliedVolatility), count(contract?.volume), count(contract?.openInterest)]
    : [count(contract?.openInterest), count(contract?.volume), iv(contract?.impliedVolatility), premium(contract?.bid), premium(contract?.ask)];
  return <>{values.map((value, index) => <Table.Td className={contract?.inTheMoney ? "tm-option-itm" : undefined} key={index} ta="right">{value}</Table.Td>)}</>;
}

function LevelMetric({ label, spot, value }: { label: React.ReactNode; spot: number; value?: number | null }) {
  const { locale } = useLocale();
  const distance = value == null || !spot ? null : value / spot - 1;
  return <div><Text c="dimmed" size="sm">{label}</Text><Text fw={800} size="xl">{value == null ? "—" : money(value, "USD", 0)}</Text><Text c="dimmed" size="xs">{distance == null ? "—" : `${pct(distance)} ${locale === "zh" ? "相对现价" : "vs spot"}`}</Text></div>;
}

function Term({ en, term, zh }: { en: string; term: string; zh: string }) {
  return <div><Text fw={700}>{term}</Text><Text c="dimmed" size="sm"><Localized zh={zh} en={en} /></Text></div>;
}

function buildStrikeRows(contracts: Contract[], expiry: string, spot: number): StrikeRow[] {
  const byStrike = new Map<number, StrikeRow>();
  for (const contract of contracts) {
    if (contract.expiry !== expiry) continue;
    const row = byStrike.get(contract.strike) ?? { strike: contract.strike };
    row[contract.side] = contract;
    byStrike.set(contract.strike, row);
  }
  return [...byStrike.values()]
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 15)
    .sort((a, b) => a.strike - b.strike);
}

function expiryLabel(expiry: Expiry, locale: "zh" | "en") {
  const date = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${expiry.expiry}T12:00:00Z`));
  if (expiry.daysToExpiry == null) return date;
  return locale === "zh"
    ? `${date} · ${expiry.daysToExpiry} 天`
    : `${date} · ${expiry.daysToExpiry} DTE`;
}

function structureSummary(option: OptionSnapshot, expiry: Expiry | undefined, zh: boolean) {
  const put = expiry?.putWall ?? option.putWall;
  const call = expiry?.callWall ?? option.callWall;
  if (put == null && call == null) return zh ? "先用逐档报价比较流动性；当前没有足够 OI 形成集中位。" : "Use strike quotes to compare liquidity; current OI is insufficient to identify concentration levels.";
  const levels = [put == null ? null : `Put ${money(put, "USD", 0)}`, call == null ? null : `Call ${money(call, "USD", 0)}`].filter(Boolean).join("、");
  return zh ? `现价 ${money(option.spot, "USD", 2)}；本到期 OI 集中在 ${levels}。这些是仓位集中位置，不是支撑、阻力或价格预测。` : `Spot is ${money(option.spot, "USD", 2)}; OI is concentrated near ${levels}. These are positioning concentrations, not support, resistance, or forecasts.`;
}

function premium(value?: number | null) { return value == null ? "—" : money(value, "USD", 2); }
function iv(value?: number | null) { return value == null ? "—" : pct(value); }
function count(value?: number | null) { return value == null ? "—" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value); }
function isAtm(rows: StrikeRow[], strike: number, spot: number) { return Math.abs(strike - spot) === Math.min(...rows.map((row) => Math.abs(row.strike - spot))); }
