"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import {
  Button,
  Checkbox,
  Drawer,
  Group,
  MultiSelect,
  Pill,
  NumberInput,
  Select,
  Stack,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import type { EChartsOption } from "echarts";
import { useState } from "react";
import { Plot } from "./charts";
import { compact, number, object, percent, str } from "./data";
import { EvidenceTable } from "./evidence-table";
import { quoteValue } from "./financial-values";
import {
  Empty,
  Facts,
  Metric,
  Panel,
  Segments,
  Tag,
  useCopy,
} from "./foundation";
import { nearMoneyStrikes } from "./research-math";
import { useRouteState } from "./route-state";

type Chain = NonNullable<ResearchLensSnapshot["options"]>;
type Contract = Chain["contracts"][number];
const baseColumns = ["bid", "ask", "iv", "oi", "volume"];
const columnNames: Record<string, string> = {
  bid: "Bid",
  ask: "Ask",
  iv: "IV",
  oi: "OI",
  volume: "Volume",
  last: "Last",
  spread: "Spread",
  delta: "Delta",
  gamma: "Gamma",
};
function validQuote(c: Contract) {
  return (
    c.bid != null && c.ask != null && c.bid >= 0 && c.ask > 0 && c.ask >= c.bid
  );
}
function sum(values: (number | null | undefined)[]) {
  return values.length && values.every((v) => v != null && Number.isFinite(v))
    ? values.reduce<number>((n, v) => n + v!, 0)
    : null;
}
function cell(c: Contract | undefined, key: string) {
  if (!c) return "—";
  if (key === "iv") return percent(c.impliedVolatility);
  if (key === "spread") return validQuote(c) ? number(c.ask! - c.bid!, 2) : "—";
  const value = {
    bid: c.bid,
    ask: c.ask,
    oi: c.openInterest,
    volume: c.volume,
    last: c.lastPrice,
    delta: c.delta,
    gamma: c.gamma,
  }[key as "bid"];
  return number(
    value,
    key === "oi" || key === "volume" ? 0 : key === "gamma" ? 5 : 2,
  );
}

export function OptionsView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy(),
    { params, update } = useRouteState();
  const [columns, setColumns] = useLocalStorage<string[]>({
    key: "mx-option-columns-v2",
    defaultValue: baseColumns,
  });
  const [liquid, setLiquid] = useState(false),
    [allStrikes, setAllStrikes] = useState(false),
    [detail, setDetail] = useState<Contract | null>(null);
  const options = data.options;
  if (!options)
    return (
      <Panel>
        <Empty title={t("暂无期权链", "Option chain unavailable")} />
      </Panel>
    );
  const historical = params.get("chainMode") === "history";
  const current = options.availability?.currentExpiries ?? [];
  const available = options.expiries.map((e) => e.expiry).sort();
  const dates = historical ? available : current;
  const requested = (params.get("expiries") ?? "")
    .split(",")
    .filter((v) => dates.includes(v));
  const selected = requested.length ? requested : dates.slice(0, 1);
  const mode = params.get("optionView") ?? "chain";
  const scoped = options.contracts.filter((c) => selected.includes(c.expiry));
  const filtered = liquid ? scoped.filter(validQuote) : scoped;
  const cc = options.currency || data.context?.quote?.currency || "";
  const value = (v: unknown) =>
    quoteValue(v, cc, t("币种未提供", "Currency unavailable"));
  const calls = scoped.filter((c) => c.side === "call"),
    puts = scoped.filter((c) => c.side === "put");
  const coi = sum(calls.map((c) => c.openInterest)),
    poi = sum(puts.map((c) => c.openInterest));
  const gexContracts = scoped.filter((c) => c.gex1pct != null);
  const gex = sum(gexContracts.map((c) => c.gex1pct));
  const active = selected[0] ?? "";
  const oneExpiry = filtered.filter((c) => c.expiry === active);
  const all = [...new Set(oneExpiry.map((c) => c.strike))].sort(
    (a, b) => a - b,
  );
  const strikes = allStrikes ? all : nearMoneyStrikes(all, options.spot, 19);
  const nearest = nearMoneyStrikes(all, options.spot, 1)[0];
  const activeSummary = options.expiries.find((e) => e.expiry === active);
  const activeCols = columns.length ? columns : baseColumns;
  const models = object(options.modelInputs),
    rate = object(models.rate);
  return (
    <>
      <Panel
        title={t("期权链", "Option chain")}
        action={
          <Group gap="sm">
            <Tag tone={historical || !current.length ? "warn" : "neutral"}>
              {historical || !current.length
                ? t("历史快照", "Historical snapshot")
                : t("最新可用链", "Latest available chain")}
            </Tag>
            <span className="mx-muted">
              {options.capturedAt.slice(0, 16).replace("T", " ")} UTC
            </span>
          </Group>
        }
      >
        <div className="mx-toolbar">
          <Segments
            label={t("期权快照", "Chain snapshot")}
            value={historical ? "history" : "current"}
            onChange={(v) => update({ chainMode: v, expiries: null })}
            options={[
              { value: "current", label: t("当前", "Current") },
              { value: "history", label: t("历史", "Historical") },
            ]}
          />
          {dates.length > 0 && (
            <MultiSelect
              renderPill={({ option, onRemove }) => (
                <Pill
                  withRemoveButton
                  onRemove={onRemove}
                  removeButtonProps={{
                    "aria-label":
                      t("移除到期日 ", "Remove expiration ") + option.label,
                  }}
                >
                  {option.label}
                </Pill>
              )}
              aria-label={t("选择已采集到期日", "Select captured expirations")}
              data={dates}
              value={selected}
              onChange={(v) => {
                if (v.length) update({ expiries: v.join(",") });
              }}
              w={320}
            />
          )}
          <span className="mx-muted">
            {t("已采集", "Captured")} {available.length}
            {options.availableExpiries?.length
              ? ` / ${options.availableExpiries.length}`
              : ""}{" "}
            {t("个到期日", "expirations")}
          </span>
        </div>
        {!dates.length ? (
          <Empty
            title={t("当前期权数据不可用", "Current chain unavailable")}
            description={t(
              "最后成功快照已过时。可以更新研究或查看历史合约。",
              "The last successful snapshot is historical. Refresh research or inspect the captured contracts.",
            )}
            action={
              <Button
                variant="light"
                onClick={() => update({ chainMode: "history" })}
              >
                {t("查看历史快照", "View historical snapshot")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="mx-metric-grid" style={{ margin: "24px 0" }}>
              <Metric
                label={t("快照标的价", "Underlying at capture")}
                value={value(options.spot)}
              />
              <Metric
                label={t("Call / Put 持仓量", "Call / Put open interest")}
                value={`${compact(coi)} / ${compact(poi)}`}
              />
              <Metric
                label={t("Put / Call 持仓比", "Put / Call OI")}
                value={
                  coi != null && coi > 0 && poi != null
                    ? number(poi / coi, 2)
                    : "—"
                }
              />
              <Metric
                label={t("合约覆盖", "Contracts captured")}
                value={number(scoped.length, 0)}
              />
            </div>
            <Segments
              label={t("期权分析", "Options analysis")}
              value={mode}
              onChange={(v) => update({ optionView: v })}
              options={[
                { value: "chain", label: t("配对链", "Paired chain") },
                { value: "iv", label: t("隐含波动率", "Implied volatility") },
                { value: "interest", label: t("持仓分布", "Open interest") },
                { value: "gamma", label: t("Gamma 估算", "Gamma estimate") },
                { value: "payoff", label: t("到期损益试算", "Expiry payoff") },
              ]}
            />
            {(mode === "chain" || mode === "iv") && (
              <div className="mx-toolbar" style={{ marginTop: 20 }}>
                <Checkbox
                  label={t("仅有效双边报价", "Valid two-sided quotes")}
                  checked={liquid}
                  onChange={(e) => setLiquid(e.currentTarget.checked)}
                />
                {selected.length > 1 && (
                  <Select
                    label={t("详细到期日", "Detail expiration")}
                    data={selected}
                    value={active}
                    onChange={(v) => {
                      if (v)
                        update({
                          expiries: [
                            v,
                            ...selected.filter((x) => x !== v),
                          ].join(","),
                        });
                    }}
                  />
                )}
              </div>
            )}
            {mode === "chain" && (
              <>
                <div className="mx-toolbar" style={{ margin: "20px 0" }}>
                  <MultiSelect
                    renderPill={({ option, onRemove }) => (
                      <Pill
                        withRemoveButton
                        onRemove={onRemove}
                        removeButtonProps={{
                          "aria-label":
                            t("移除列 ", "Remove column ") + option.label,
                        }}
                      >
                        {option.label}
                      </Pill>
                    )}
                    aria-label={t("期权链列", "Option chain columns")}
                    data={Object.entries(columnNames).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    value={activeCols}
                    onChange={setColumns}
                    w={480}
                  />
                  <Checkbox
                    label={t("所有行权价", "All strikes")}
                    checked={allStrikes}
                    onChange={(e) => setAllStrikes(e.currentTarget.checked)}
                  />
                  <span>
                    {active} · {cc} · {strikes.length} {t("档", "strikes")}
                  </span>
                </div>
                <div
                  className="mx-table-wrap mx-option-chain"
                  role="region"
                  tabIndex={0}
                  aria-label={t("看涨与看跌配对链", "Paired calls and puts")}
                >
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th colSpan={activeCols.length}>Calls</th>
                        <th className="mx-strike">
                          {t("行权价", "Strike")} · {cc}
                        </th>
                        <th colSpan={activeCols.length}>Puts</th>
                      </tr>
                      <tr>
                        {[...activeCols].reverse().map((k) => (
                          <th scope="col" key={k}>
                            {columnNames[k]}
                          </th>
                        ))}
                        <th scope="col" className="mx-strike">
                          {active}
                        </th>
                        {activeCols.map((k) => (
                          <th scope="col" key={k}>
                            {columnNames[k]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {strikes.map((strike) => {
                        const call = oneExpiry.find(
                            (c) => c.strike === strike && c.side === "call",
                          ),
                          put = oneExpiry.find(
                            (c) => c.strike === strike && c.side === "put",
                          );
                        return (
                          <tr
                            key={strike}
                            className={
                              strike === nearest ? "mx-near-spot" : undefined
                            }
                          >
                            {[...activeCols].reverse().map((k) => (
                              <td
                                key={k}
                                className={
                                  call?.inTheMoney ? "mx-option-itm" : undefined
                                }
                              >
                                <button
                                  disabled={!call}
                                  tabIndex={k === activeCols[0] ? 0 : -1}
                                  className="mx-cell-button"
                                  onClick={() => setDetail(call!)}
                                  aria-label={`Call ${strike} ${columnNames[k]} ${cell(call, k)}`}
                                >
                                  {cell(call, k)}
                                </button>
                              </td>
                            ))}
                            <th scope="row" className="mx-strike">
                              {number(strike, 2)}
                              {strike === nearest && (
                                <small>{t("近现价", "Nearest spot")}</small>
                              )}
                            </th>
                            {activeCols.map((k) => (
                              <td
                                key={k}
                                className={
                                  put?.inTheMoney ? "mx-option-itm" : undefined
                                }
                              >
                                <button
                                  disabled={!put}
                                  tabIndex={k === activeCols[0] ? 0 : -1}
                                  className="mx-cell-button"
                                  onClick={() => setDetail(put!)}
                                  aria-label={`Put ${strike} ${columnNames[k]} ${cell(put, k)}`}
                                >
                                  {cell(put, k)}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {mode === "iv" && (
              <Volatility
                options={options}
                contracts={oneExpiry}
                active={active}
                dates={selected}
                liquid={liquid}
              />
            )}
            {mode === "interest" && (
              <>
                <OptionPlot
                  label={t(
                    "所选到期日未平仓合约数",
                    "Open interest for selected expirations",
                  )}
                  option={{
                    legend: { top: 0, data: ["Calls", "Puts"] },
                    grid: { left: 72, right: 24, top: 42, bottom: 54 },
                    xAxis: {
                      type: "category",
                      name: t("行权价", "Strike"),
                      data: [...new Set(filtered.map((c) => c.strike))].sort(
                        (a, b) => a - b,
                      ),
                    },
                    yAxis: { type: "value", name: t("合约数", "Contracts") },
                    series: ["call", "put"].map((side) => ({
                      name: side === "call" ? "Calls" : "Puts",
                      type: "bar",
                      data: [...new Set(filtered.map((c) => c.strike))]
                        .sort((a, b) => a - b)
                        .map((strike) =>
                          sum(
                            filtered
                              .filter(
                                (c) => c.strike === strike && c.side === side,
                              )
                              .map((c) => c.openInterest),
                          ),
                        ),
                    })),
                  }}
                />
                <Readings
                  columns={[
                    t("到期日", "Expiry"),
                    "Call OI",
                    "Put OI",
                    "Put / Call",
                  ]}
                  rows={options.expiries
                    .filter((e) => selected.includes(e.expiry))
                    .map((e) => [
                      e.expiry,
                      number(e.callOpenInterest, 0),
                      number(e.putOpenInterest, 0),
                      number(e.putCallOiRatio, 2),
                    ])}
                />
              </>
            )}
            {mode === "gamma" && (
              <div style={{ marginTop: 24 }}>
                <div className="mx-metric-grid">
                  <Metric
                    label={t("Gamma 敞口估算", "Estimated gamma exposure")}
                    value={value(gex)}
                    note={`${cc} / 1% ${t("标的价格变化", "underlying move")}`}
                  />
                  <Metric
                    label={t("可建模合约", "Modeled contracts")}
                    value={`${gexContracts.length} / ${scoped.length}`}
                  />
                </div>
                {gexContracts.length ? (
                  <OptionPlot
                    label={t(
                      "所选到期日的价格情景",
                      "Spot scenarios for selected expirations",
                    )}
                    option={{
                      legend: { top: 0, type: "scroll", data: selected },
                      grid: { left: 80, right: 24, top: 44, bottom: 48 },
                      xAxis: { type: "value", name: cc, scale: true },
                      yAxis: {
                        type: "value",
                        name: `${cc} / 1%`,
                        axisLabel: { formatter: (v: number) => compact(v) },
                      },
                      series: options.expiries
                        .filter((e) => selected.includes(e.expiry))
                        .map((e) => ({
                          name: e.expiry,
                          type: "line",
                          showSymbol: false,
                          connectNulls: false,
                          data: e.gammaProfile.map((p) => [p.spot, p.netGex]),
                          markLine: {
                            symbol: "none",
                            label: { show: false },
                            data: [{ yAxis: 0 }],
                          },
                        })),
                    }}
                  />
                ) : (
                  <Empty
                    title={t(
                      "必要合约条件或利率缺失",
                      "Required contract terms or rate unavailable",
                    )}
                  />
                )}
                <details>
                  <summary>{t("估算方法与输入", "Method and inputs")}</summary>
                  <Facts
                    rows={[
                      [
                        t("公式", "Formula"),
                        "Gamma × OI × multiplier × spot² × 0.01",
                      ],
                      [
                        t("符号假设", "Sign convention"),
                        t(
                          "Call 为正、Put 为负；不代表交易商实际仓位",
                          "Calls positive, puts negative; not observed dealer inventory",
                        ),
                      ],
                      [
                        t("定价近似", "Pricing approximation"),
                        str(models.pricingModel) || "—",
                      ],
                      [
                        t("风险利率", "Risk-free proxy"),
                        `${percent(rate.value)} · ${str(rate.asOf) || "—"}`,
                      ],
                      [t("利率来源", "Rate source"), str(rate.source) || "—"],
                      [t("利率方法", "Rate method"), str(rate.method) || "—"],
                      [
                        t("股息率", "Dividend yield"),
                        `${percent(models.dividendYield)} · ${str(models.dividendYieldBasis)}`,
                      ],
                      [
                        t("波动率假设", "Volatility assumption"),
                        str(models.volatilityConvention) || "—",
                      ],
                      [
                        t("模型版本", "Model version"),
                        str(models.formulaVersion) || "—",
                      ],
                    ]}
                  />
                </details>
              </div>
            )}
            {mode === "payoff" && (
              <Payoff
                contracts={scoped.filter((c) => c.expiry === active)}
                spot={options.spot}
                currencyCode={cc}
                key={active}
              />
            )}
            {activeSummary?.expiryInstant && (
              <details style={{ marginTop: 20 }}>
                <summary>
                  {t("合约时间与覆盖", "Contract time and coverage")}
                </summary>
                <Facts
                  rows={[
                    [
                      t("到期日定价截止", "Expiry pricing cutoff"),
                      activeSummary.expiryInstant,
                    ],
                    [t("采集时间", "Captured at"), options.capturedAt],
                    [
                      t("报价时间", "Quote timestamp"),
                      t(
                        "按合约查看；源未给出时留空",
                        "Per contract; unavailable timestamps remain missing",
                      ),
                    ],
                    [
                      t("持仓量覆盖", "OI coverage"),
                      `${scoped.filter((c) => c.openInterest != null).length} / ${scoped.length}`,
                    ],
                  ]}
                />
              </details>
            )}
          </>
        )}
      </Panel>
      <Drawer
        opened={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.contractSymbol || t("合约详情", "Contract details")}
        position="right"
        size="md"
      >
        {detail && (
          <Facts
            rows={[
              ["Bid / Ask", `${number(detail.bid)} / ${number(detail.ask)}`],
              ["Last", number(detail.lastPrice)],
              [t("最后成交", "Last trade"), detail.lastTradeAt || "—"],
              [t("报价时间", "Quote time"), detail.quoteAsOf || "—"],
              [t("OI 时间", "OI timestamp"), detail.openInterestAsOf || "—"],
              [t("乘数", "Multiplier"), number(detail.multiplier, 0)],
              [t("行权方式", "Exercise"), detail.exerciseStyle || "—"],
              [t("结算方式", "Settlement"), detail.settlement || "—"],
              [t("到期截止", "Expiry cutoff"), detail.expiryInstant || "—"],
              [
                "Delta / Gamma",
                `${number(detail.delta, 4)} / ${number(detail.gamma, 6)}`,
              ],
              ["Gamma / 1%", value(detail.gex1pct)],
              [
                t("报价质量", "Quote quality"),
                validQuote(detail)
                  ? t("有效双边报价", "Valid two-sided quote")
                  : t("缺失或交叉报价", "Missing or crossed quote"),
              ],
            ]}
          />
        )}
      </Drawer>
    </>
  );
}

function Volatility({
  options,
  contracts,
  active,
  dates,
  liquid,
}: {
  options: Chain;
  contracts: Contract[];
  active: string;
  dates: string[];
  liquid: boolean;
}) {
  const t = useCopy();
  const valid = contracts.filter(
    (c) => c.impliedVolatility != null && c.impliedVolatility > 0,
  );
  const term = options.expiries
    .filter((e) => dates.includes(e.expiry))
    .map((e) => {
      const cs = options.contracts.filter(
        (c) =>
          c.expiry === e.expiry &&
          c.impliedVolatility != null &&
          c.impliedVolatility > 0 &&
          (!liquid || validQuote(c)),
      );
      const k = nearMoneyStrikes(
        cs.map((c) => c.strike),
        options.spot,
        1,
      )[0];
      const atm = cs.filter((c) => c.strike === k);
      return {
        expiry: e.expiry,
        strike: k,
        call: atm.find((c) => c.side === "call")?.impliedVolatility ?? null,
        put: atm.find((c) => c.side === "put")?.impliedVolatility ?? null,
      };
    });
  return (
    <div style={{ marginTop: 24 }}>
      <OptionPlot
        label={`${active} ${t("IV 微笑", "IV smile")}`}
        option={{
          legend: { top: 0, data: ["Calls", "Puts"] },
          grid: { left: 64, right: 24, top: 44, bottom: 54 },
          xAxis: {
            type: "value",
            name: t("行权价 / 现价", "Strike / spot"),
            scale: true,
            axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
          },
          yAxis: {
            type: "value",
            name: "IV",
            axisLabel: { formatter: (v: number) => percent(v) },
          },
          tooltip: {
            formatter: (input) => {
              const entries = Array.isArray(input) ? input : [input];
              return entries.map((entry) => {
                const [moneyness, iv] = entry.value as number[];
                return `${entry.seriesName} · ${t("行权价 / 现价", "Strike / spot")} ${percent(moneyness)}\nIV ${percent(iv, false, 2)}`;
              }).join("\n");
            },
          },
          series: ["call", "put"].map((side) => ({
            name: side === "call" ? "Calls" : "Puts",
            type: "line",
            smooth: false,
            connectNulls: false,
            symbolSize: 5,
            data: valid
              .filter((c) => c.side === side)
              .sort((a, b) => a.strike - b.strike)
              .map((c) => [c.strike / options.spot, c.impliedVolatility]),
          })),
        }}
      />
      <h3>{t("近价 IV 期限结构", "ATM IV term structure")}</h3>
      {term.length > 1 && (
        <OptionPlot
          height={250}
          label={t(
            "已选到期日近价波动率",
            "ATM volatility at selected expirations",
          )}
          option={{
            legend: { top: 0, data: ["Calls", "Puts"] },
            grid: { left: 60, right: 20, top: 44, bottom: 44 },
            xAxis: { type: "category", data: term.map((r) => r.expiry) },
            yAxis: {
              type: "value",
              name: "IV",
              axisLabel: { formatter: (v: number) => percent(v) },
            },
            tooltip: { valueFormatter: (value) => percent(value, false, 2) },
            series: ["call", "put"].map((side) => ({
              name: side === "call" ? "Calls" : "Puts",
              type: "line",
              smooth: false,
              connectNulls: false,
              data: term.map((r) => (side === "call" ? r.call : r.put)),
            })),
          }}
        />
      )}
      <Readings
        columns={[
          t("到期日", "Expiry"),
          t("最近行权价", "Nearest strike"),
          "Call IV",
          "Put IV",
        ]}
        rows={term.map((r) => [
          r.expiry,
          number(r.strike),
          percent(r.call),
          percent(r.put),
        ])}
      />
    </div>
  );
}

type Leg = {
  symbol: string;
  quantity: number;
  premium: number | null;
  fee: number;
};
function Payoff({
  contracts,
  spot,
  currencyCode,
}: {
  contracts: Contract[];
  spot: number;
  currencyCode: string;
}) {
  const t = useCopy();
  const [legs, setLegs] = useState<Leg[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const eligible = contracts.filter(
    (c) => c.multiplier != null && c.multiplier > 0 && c.contractSymbol,
  );
  const add = () => {
    const c = eligible.find((c) => c.contractSymbol === selected);
    if (c && legs.length < 4)
      setLegs([
        ...legs,
        {
          symbol: c.contractSymbol!,
          quantity: 1,
          premium: validQuote(c) ? (c.bid! + c.ask!) / 2 : null,
          fee: 0,
        },
      ]);
  };
  const pnl = (price: number) =>
    legs.reduce((total, l) => {
      const c = eligible.find((c) => c.contractSymbol === l.symbol)!;
      return (
        total +
        ((c.side === "call"
          ? Math.max(price - c.strike, 0)
          : Math.max(c.strike - price, 0)) -
          l.premium!) *
          l.quantity *
          c.multiplier! -
        Math.abs(l.quantity) * l.fee
      );
    }, 0);
  const max = Math.max(
    spot * 1.5,
    ...legs.map(
      (l) =>
        (eligible.find((c) => c.contractSymbol === l.symbol)?.strike ?? 0) *
        1.3,
    ),
  );
  const points = [
    ...new Set([
      0,
      spot,
      ...Array.from({ length: 61 }, (_, i) => (max * i) / 60),
      ...legs.flatMap((l) => {
        const contract = eligible.find((c) => c.contractSymbol === l.symbol);
        return contract ? [contract.strike] : [];
      }),
    ]),
  ].sort((a, b) => a - b);
  const edit = (
    i: number,
    key: "quantity" | "premium" | "fee",
    n: number | null,
  ) => setLegs(legs.map((l, j) => (i === j ? { ...l, [key]: n } : l)));
  const complete = legs.every(
    (l) =>
      l.premium !== null && eligible.some((c) => c.contractSymbol === l.symbol),
  );
  return (
    <Stack mt="lg">
      <Group align="end">
        <Select
          label={t("合约", "Contract")}
          searchable
          data={eligible.map((c) => ({
            value: c.contractSymbol!,
            label: `${c.side.toUpperCase()} ${c.strike} · ${c.expiry}`,
          }))}
          value={selected}
          onChange={setSelected}
          w={320}
        />
        <Button
          variant="light"
          onClick={add}
          disabled={!selected || legs.length >= 4}
        >
          {t("加入试算", "Add to analysis")}
        </Button>
      </Group>
      {legs.map((leg, i) => (
        <Group key={i} align="end">
          <span>{leg.symbol}</span>
          <NumberInput
            label={t("数量（负数为卖出）", "Quantity (negative = short)")}
            value={leg.quantity}
            min={-100}
            max={100}
            allowDecimal={false}
            onChange={(v) => edit(i, "quantity", Number(v))}
            w={150}
          />
          <NumberInput
            label={`${t("假设权利金", "Assumed premium")} · ${currencyCode}`}
            value={leg.premium ?? ""}
            placeholder={t("请输入", "Enter premium")}
            min={0}
            onChange={(v) => edit(i, "premium", v === "" ? null : Number(v))}
            w={150}
          />
          <NumberInput
            label={t("每张费用", "Cost per contract")}
            value={leg.fee}
            min={0}
            onChange={(v) => edit(i, "fee", Number(v))}
            w={130}
          />
          <Button
            variant="subtle"
            color="red"
            onClick={() => setLegs(legs.filter((_, j) => i !== j))}
          >
            {t("移除", "Remove")}
          </Button>
        </Group>
      ))}
      {legs.length > 0 && !complete && (
        <Empty
          title={t(
            "填写每个合约的权利金后查看损益",
            "Enter a premium for each contract to calculate P/L",
          )}
        />
      )}
      {legs.length > 0 && complete && (
        <>
          <OptionPlot
            label={t("到期损益试算", "Hypothetical expiration P/L")}
            option={{
              grid: { left: 80, right: 24, top: 30, bottom: 48 },
              xAxis: { type: "value", name: currencyCode },
              yAxis: {
                type: "value",
                name: `P/L · ${currencyCode}`,
                axisLabel: { formatter: (v: number) => compact(v) },
              },
              series: [
                {
                  name: t("到期损益", "Expiry P/L"),
                  type: "line",
                  showSymbol: false,
                  data: points.map((p) => [p, pnl(p)]),
                  markLine: {
                    symbol: "none",
                    label: { show: false },
                    data: [{ yAxis: 0 }],
                  },
                },
              ],
            }}
          />
          <Readings
            columns={[
              t("到期标的价", "Underlying at expiry"),
              `P/L · ${currencyCode}`,
            ]}
            rows={[0, spot * 0.75, spot, spot * 1.25, max].map((p) => [
              number(p),
              number(pnl(p)),
            ])}
          />
        </>
      )}
      {!legs.length && (
        <Empty
          title={t(
            "选择同一到期日的合约开始试算",
            "Select contracts sharing an expiration",
          )}
        />
      )}
      <details>
        <summary>{t("试算假设", "Payoff assumptions")}</summary>
        <p>
          {t(
            "仅计算到期内在价值，扣除填写的权利金和费用；不含提前指派、融资与税费。负数量表示卖出，裸卖 Call 的亏损没有上限。图的价格范围不代表最大风险。",
            "Expiration intrinsic value less entered premiums and costs; excludes early assignment, financing and tax. Negative quantities are short. Naked short calls have unlimited loss; the chart range is not a risk bound.",
          )}
        </p>
      </details>
    </Stack>
  );
}

function OptionPlot({
  option,
  label,
  height,
}: {
  option: EChartsOption;
  label: string;
  height?: number;
}) {
  return <Plot research label={label} height={height} option={() => option} />;
}
function Readings({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const t = useCopy();
  return (
    <EvidenceTable
      label={t("精确记录", "Exact records")}
      rows={rows}
      columns={columns.map((label, i) => ({
        label,
        value: (row: string[]) => row[i],
        numeric: i > 0,
      }))}
    />
  );
}
