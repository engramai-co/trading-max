"use client";

import { SystemNotes } from "./review-evidence";
import { impliedGrowthLabel } from "./research-display";
import { quoteValue } from "./financial-values";
import { ValuationSensitivity } from "./research-sensitivity";
import {
  Button,
  Drawer,
  Group,
  NumberInput,
  Select,
  Stack,
} from "@mantine/core";
import { SlidersHorizontal } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  ResearchLensSnapshot,
  ValuationAssumptionsState,
  ValuationAssumptionsHistoryEntry,
  ValuationCompanyAssumptions,
} from "@/lib/types";
import { expirationSummary, nearMoneyStrikes } from "./research-math";
import { EvidenceTable } from "./evidence-table";
import { Legend, Plot } from "./charts";
import {
  api,
  compact,
  currency,
  jsonRequest,
  number,
  numeric,
  object,
  str,
  percent,
  tone,
} from "./data";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  Notice,
  Panel,
  Pending,
  QueryError,
  Segments,
  Tabs,
  Tag,
  useCopy,
} from "./foundation";

import {
  assumptionChange,
  assumptionErrors,
  assumptionFields,
  scenarioKeys,
  scenarioLabel,
} from "./valuation-assumptions";
export function ValuationView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [horizon, setHorizon] = useState("5");
  const [editing, setEditing] = useState(false);
  const v = data.valuation;
  if (
    ["ETF", "MUTUALFUND"].includes(String(object(data.market).quoteType ?? ""))
  )
    return (
      <Panel>
        <Empty
          title={t(
            "公司估值模型不适用于基金",
            "Company valuation models do not apply to funds",
          )}
          description={t(
            "基金的价值取决于底层资产，可在全貌中查看组合敞口。",
            "Fund values depend on their underlying assets. See the overview for portfolio exposure.",
          )}
        />
      </Panel>
    );
  if (!v)
    return (
      <Panel>
        <Empty
          title={t("估值模型还未就绪", "Valuation model is not ready")}
          description={t(
            "完整研究更新会计算模型价值，并保留假设与数据限制。",
            "A full research update calculates model values with assumptions and data limitations.",
          )}
        />
      </Panel>
    );
  const value = horizon === "5" ? v.ev5 : v.ev10;
  const upside = horizon === "5" ? v.ev5Upside : v.ev10Upside;
  const labels = [
    t("保守情景", "Bear case"),
    t("基准情景", "Base case"),
    t("乐观情景", "Bull case"),
  ];
  const scenarioValues = scenarioKeys.map((key) =>
    horizon === "5" ? v.scenarios[key]?.value : v.scenarios[key]?.value10,
  );
  return (
    <>
      <Panel
        title={t("估值概览", "Valuation overview")}
        help={t(
          "现金流模型采用股权自由现金流估计。市场隐含增长由五年模型反推，不随显示周期改变。",
          "The model estimates levered equity cash flow. Price-implied growth is solved using the five-year model, independently of the displayed horizon.",
        )}
        action={
          <Button
            variant="default"
            size="xs"
            leftSection={<SlidersHorizontal size={15} />}
            onClick={() => setEditing(true)}
          >
            {t("查看与调整假设", "Inspect assumptions")}
          </Button>
        }
      >
        <div className="mx-toolbar" style={{ marginBottom: 24 }}>
          <Segments
            label={t("估值周期", "Valuation horizon")}
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "5", label: t("五年模型", "5-year model") },
              { value: "10", label: t("十年模型", "10-year model") },
            ]}
          />
          <Freshness date={v.asOf} />
        </div>
        <div className="mx-metric-grid">
          <Metric
            label={t("现价", "Market price")}
            value={currency(v.spot, v.currency, 2)}
          />
          <Metric
            label={t("模型基准价值", "Base model value")}
            value={currency(value, v.currency, 2)}
          />
          <Metric
            label={t("模型上 / 下行空间", "Model upside / downside")}
            value={percent(upside, true)}
            tone={tone(upside)}
          />
          <Metric
            label={t("五年隐含增长", "5-year implied growth")}
            value={impliedGrowthLabel(v.impliedGrowth, v.impliedGrowthBound)}
          />
        </div>
        <details className="mx-chart-data">
          <summary>
            {t("同时对照五年与十年模型", "Compare five- and ten-year models")}
          </summary>
          <Facts
            rows={[
              [
                t("五年价值 / 空间", "5-year value / upside"),
                currency(v.ev5, v.currency, 2) +
                  " · " +
                  percent(v.ev5Upside, true),
              ],
              [
                t("十年价值 / 空间", "10-year value / upside"),
                currency(v.ev10, v.currency, 2) +
                  " · " +
                  percent(v.ev10Upside, true),
              ],
            ]}
          />
        </details>
      </Panel>
      {v.modelWarnings.some(
        (note) =>
          !note.startsWith(
            "provider free cash flow is treated as a levered FCF proxy",
          ),
      ) && (
        <SystemNotes
          values={v.modelWarnings.filter(
            (note) =>
              !note.startsWith(
                "provider free cash flow is treated as a levered FCF proxy",
              ),
          )}
        />
      )}
      <Panel title={t("情景估值", "Scenario valuations")}>
        {scenarioValues.some((value) => value != null) ? (
          <>
            <Plot
              research
              height={195}
              label={t(
                "估值情景与当前价格",
                "Valuation scenarios and current price",
              )}
              option={(c) => ({
                grid: { left: 85, right: 115, top: 28, bottom: 35 },
                xAxis: {
                  type: "value",
                  scale: true,
                  name: v.currency,
                  nameTextStyle: { color: c.axis },
                  axisLabel: { color: c.axis },
                  splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                },
                yAxis: {
                  type: "category",
                  inverse: true,
                  data: labels,
                  axisLabel: { color: c.text },
                  axisLine: { show: false },
                  axisTick: { show: false },
                },
                tooltip: {
                  trigger: "item",
                  formatter: (input) => {
                    const row = (Array.isArray(input) ? input : [input])[0];
                    return (
                      labels[row.dataIndex] +
                      "\n" +
                      currency(scenarioValues[row.dataIndex], v.currency, 2)
                    );
                  },
                },
                series: [
                  {
                    type: "scatter",
                    symbolSize: 12,
                    data: scenarioValues.map((value, i) => ({
                      value: [value ?? null, i],
                      itemStyle: { color: i === 1 ? c.brand : c.axis },
                    })),
                    label: {
                      show: true,
                      position: "right",
                      distance: 10,
                      color: c.text,
                      formatter: (point) =>
                        currency(
                          scenarioValues[point.dataIndex],
                          v.currency,
                          2,
                        ),
                    },
                    markLine: {
                      silent: true,
                      symbol: "none",
                      lineStyle: { type: "dashed", color: c.axis },
                      label: {
                        formatter:
                          t("现价 ", "Spot ") + currency(v.spot, v.currency, 2),
                        position: "end",
                        color: c.axis,
                      },
                      data: [{ xAxis: v.spot }],
                    },
                  },
                ],
              })}
            />
          </>
        ) : (
          <Empty
            title={t("没有可用的情景分解", "Scenario breakdown unavailable")}
            description={t(
              "当前数据不足以计算情景估值。",
              "Available data is insufficient for scenario valuations.",
            )}
          />
        )}
        <div
          className="mx-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("数据表格", "Data table")}
        >
          <table className="mx-table">
            <thead>
              <tr>
                <th>{t("假设", "Assumption")}</th>
                {labels.map((l) => (
                  <th key={l} className="mx-align-right">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                {
                  label: t("营收年复合增长", "Revenue CAGR"),
                  key: "revenueCagr",
                },
                {
                  label: t("目标自由现金流率", "Target FCF margin"),
                  key: "targetFcfMargin",
                },
                { label: t("折现率", "Discount rate"), key: "discountRate" },
                {
                  label: t("退出现金流倍数", "Exit FCF multiple"),
                  key: "exitFcfMultiple",
                },
                {
                  label: t("股数年变化", "Share-count CAGR"),
                  key: "shareCagr",
                },
              ].map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  {scenarioKeys.map((key) => (
                    <td className="mx-align-right" key={key}>
                      {row.key === "exitFcfMultiple"
                        ? number(object(v.scenarios[key])[row.key])
                        : percent(object(v.scenarios[key])[row.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="mx-grid mx-valuation-context">
        <Panel
          title={t("增长假设对照", "Growth assumptions")}
          help={t(
            "已报告值是营收同比。基准与隐含值为模型的营收年复合增长率；隐含增长表示现价对应的模型假设。",
            "Reported growth is revenue YoY. Base and implied growth are model revenue CAGRs; implied growth is the assumption consistent with spot in this model.",
          )}
        >
          <Facts
            rows={[
              [
                t("已报告营收同比", "Reported revenue YoY"),
                percent(v.reportedGrowth),
              ],
              [t("基准营收 CAGR", "Base revenue CAGR"), percent(v.baseGrowth)],
              [
                t("五年价格隐含 CAGR", "5-year price-implied CAGR"),
                impliedGrowthLabel(v.impliedGrowth, v.impliedGrowthBound),
              ],
            ]}
          />
        </Panel>
        <Panel
          title={t("市场估值参照", "Market valuation references")}
          className="mx-valuation-references"
        >
          <Facts
            rows={[
              [t("市盈率 · 历史", "Trailing P/E"), number(v.trailingPe)],
              [t("市盈率 · 预期", "Forward P/E"), number(v.forwardPe)],
              [t("市销率", "Price / sales"), number(v.priceToSales)],
              [t("市净率", "Price / book"), number(v.priceToBook)],
              ["EV / EBITDA", number(v.enterpriseToEbitda)],
              [
                t("分析师目标中位数", "Median analyst target"),
                currency(v.analystMedian, v.currency, 2),
              ],
              [
                t("终值退出倍数", "Terminal exit multiple"),
                number(v.terminalCheck.exitMultiple),
              ],
              [
                t("Gordon 交叉检查", "Gordon cross-check"),
                number(v.terminalCheck.gordonMultiple),
              ],
            ]}
          />
        </Panel>
      </div>
      <ValuationSensitivity value={v} />
      <Drawer
        opened={editing}
        onClose={() => setEditing(false)}
        title={t("模型假设工作表", "Model assumptions")}
        size={720}
      >
        <AssumptionsEditor
          ticker={data.ticker}
          name={data.ticker}
          current={v.scenarios}
          key={data.ticker}
        />
      </Drawer>
    </>
  );
}
type CurrentScenarios = NonNullable<
  ResearchLensSnapshot["valuation"]
>["scenarios"];
function AssumptionsEditor({
  ticker,
  name,
  current,
}: {
  ticker: string;
  name: string;
  current: CurrentScenarios;
}) {
  const query = useQuery({
    queryKey: ["workspace-assumptions"],
    queryFn: () => api<ValuationAssumptionsState>("/valuation/assumptions"),
    retry: 0,
  });
  return query.isPending ? (
    <Pending />
  ) : query.isError ? (
    <QueryError retry={query.refetch} />
  ) : (
    <AssumptionsForm
      key={ticker}
      current={current}
      initial={
        query.data?.companies.find((c) => c.ticker === ticker) ?? {
          ticker,
          name,
          source: "manual",
          updatedAt: null,
          scenarios: {},
        }
      }
    />
  );
}
function AssumptionsForm({
  initial,
  current,
}: {
  initial: ValuationCompanyAssumptions;
  current: CurrentScenarios;
}) {
  const t = useCopy();
  const [scenarios, setScenarios] = useState(initial.scenarios);
  const [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState(initial.scenarios);
  const dirty = JSON.stringify(scenarios) !== JSON.stringify(baseline);
  const history = useQuery({
    queryKey: ["workspace-assumptions-history"],
    queryFn: () =>
      api<ValuationAssumptionsHistoryEntry[]>(
        "/valuation/assumptions/history?limit=500",
      ),
  });
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api(
        "/valuation/assumptions/" + encodeURIComponent(initial.ticker),
        jsonRequest("PUT", { name: initial.name, scenarios, source: "manual" }),
      ),
    onSuccess: () => {
      setSaved(true);
      setBaseline(scenarios);
      void client.invalidateQueries({
        queryKey: ["workspace-assumptions-history"],
      });
      void client.invalidateQueries({ queryKey: ["workspace-assumptions"] });
    },
  });
  const errors = save.isError ? assumptionErrors(save.error, t) : null;
  return (
    <Stack gap="lg">
      <Notice>
        {t(
          "保存后，点击证券页的“更新研究”重新计算估值。",
          "After saving, select Update research on the security page to recalculate valuation.",
        )}
      </Notice>
      {scenarioKeys.map((scenario) => (
        <Panel key={scenario} title={scenarioLabel(scenario, t)}>
          <div className="mx-grid">
            {assumptionFields.map((field) => (
              <NumberInput
                key={field.key}
                label={t(field.label[0], field.label[1])}
                placeholder={
                  numeric(object(current[scenario])[field.key]) == null
                    ? t("自动", "Automatic")
                    : t("当前模型 ", "Current model ") +
                      number(
                        Number(object(current[scenario])[field.key]) *
                          (field.percent ? 100 : 1),
                        2,
                      ) +
                      (field.percent ? "%" : "×")
                }
                error={errors?.fields[scenario + "." + field.key]}
                suffix={field.percent ? "%" : "×"}
                disabled={save.isPending}
                decimalScale={2}
                min={field.min}
                max={field.max}
                value={
                  scenarios[scenario]?.[field.key] == null
                    ? ""
                    : Number(scenarios[scenario]?.[field.key]) *
                      (field.percent ? 100 : 1)
                }
                onChange={(value) => {
                  setSaved(false);
                  setScenarios((current) => ({
                    ...current,
                    [scenario]: {
                      ...current[scenario],
                      [field.key]:
                        numeric(value) == null
                          ? null
                          : Number(value) / (field.percent ? 100 : 1),
                    },
                  }));
                }}
              />
            ))}
          </div>
        </Panel>
      ))}
      {errors && <Notice tone="bad">{errors.message}</Notice>}
      {saved && (
        <Notice tone="good">
          {t(
            "假设已保存。更新证券研究后可查看新模型结果。",
            "Assumptions saved. Update security research to see the recalculated model.",
          )}
        </Notice>
      )}
      <Button
        disabled={!dirty}
        loading={save.isPending}
        onClick={() => save.mutate()}
      >
        {t("保存研究假设", "Save assumptions")}
      </Button>
      <Button
        variant="default"
        disabled={!dirty || save.isPending}
        onClick={() => {
          setScenarios(baseline);
          setSaved(false);
        }}
      >
        {t("撤销未保存的修改", "Discard unsaved changes")}
      </Button>
      <Panel
        title={t("假设修改记录", "Assumption history")}
        help={t(
          "从最近 500 条修改中查找此证券的记录，更早的修改可能未列出。",
          "Lists this security’s changes within the latest 500 revisions; earlier changes may not appear.",
        )}
      >
        {history.isPending ? (
          <Pending />
        ) : history.isError ? (
          <QueryError retry={history.refetch} />
        ) : (
          <EvidenceTable
            label={t("假设版本记录", "Assumption revisions")}
            rows={(history.data ?? []).filter(
              (row) => row.ticker === initial.ticker,
            )}
            columns={[
              {
                label: t("版本", "Revision"),
                value: (row) => String(row.revision),
              },
              {
                label: t("时间", "Changed at"),
                value: (row) => <Freshness date={row.changedAt} />,
              },
              {
                label: t("修改", "Changes"),
                value: (row) =>
                  Object.entries(row.changes).map(([key, change]) => (
                    <div key={key}>
                      {assumptionChange(key, change.before, change.after, t)}
                    </div>
                  )),
              },
            ]}
          />
        )}
      </Panel>
    </Stack>
  );
}
export function OptionsView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [tab, setTab] = useState("near");
  const [expiry, setExpiry] = useState("");
  const [side, setSide] = useState("all");
  const [limit, setLimit] = useState(40);
  const options = data.options;
  if (!options)
    return (
      <Panel>
        <Empty
          title={t(
            "这项证券暂无期权覆盖",
            "No options coverage for this security",
          )}
          description={t(
            "期权信息取决于交易所和数据源的覆盖范围。",
            "Options availability depends on exchange and provider coverage.",
          )}
        />
      </Panel>
    );
  const expiries = [
    ...new Set([
      ...options.expiries.map((e) => e.expiry),
      ...options.contracts.map((c) => c.expiry),
    ]),
  ].sort();
  const activeExpiry = expiries.includes(expiry) ? expiry : (expiries[0] ?? "");
  const contracts = options.contracts
    .filter((c) => c.expiry === activeExpiry)
    .sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
  const strikes = [...new Set(contracts.map((c) => c.strike))];
  const rows = contracts.filter((c) => side === "all" || c.side === side);
  const expiryData = expirationSummary(options.expiries, activeExpiry);
  const summary = tab === "gamma" ? options : expiryData;
  const optionCurrency = str(
    object(data.market).currency ?? data.valuation?.currency,
  );
  const optionValue = (value: unknown) =>
    quoteValue(value, optionCurrency, t("币种未提供", "Currency unavailable"));
  const nearStrikes = nearMoneyStrikes(strikes, options.spot);
  const closest = nearMoneyStrikes(strikes, options.spot, 1)[0];
  return (
    <>
      <Panel
        title={t("期权结构", "Options structure")}
        action={<Freshness date={options.capturedAt} />}
        help={
          tab === "gamma"
            ? t(
                "Gamma 敞口根据期权快照与模型假设估算，不能据此确认交易商的实际仓位。",
                "Gamma exposure is estimated from option snapshots and model assumptions; it does not reveal actual dealer positions.",
              )
            : undefined
        }
      >
        <Tabs
          label={t("期权视图", "Options perspective")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "near", label: t("近价合约", "Near the money") },
            { value: "interest", label: t("持仓分布", "Open interest") },
            { value: "gamma", label: "Gamma" },
            { value: "chain", label: t("合约明细", "Option chain") },
          ]}
        />
        {tab !== "gamma" && (
          <div className="mx-toolbar" style={{ margin: "20px 0" }}>
            <Select
              aria-label={t("到期日期", "Expiration date")}
              value={activeExpiry || null}
              onChange={(v) => {
                setExpiry(v ?? "");
                setLimit(40);
              }}
              placeholder={t("暂无到期数据", "No expiration data")}
              data={expiries}
              w={180}
            />
            {expiryData && (
              <Tag>
                {t("快照时距到期 ", "At capture: ")}
                {number(expiryData.daysToExpiry, 0)}
                {t(" 天", " days to expiry")}
              </Tag>
            )}
            {tab === "chain" && (
              <Segments
                value={side}
                onChange={(v) => {
                  setSide(v);
                  setLimit(40);
                }}
                label={t("期权方向", "Option side")}
                options={[
                  { value: "all", label: t("全部", "All") },
                  { value: "call", label: t("看涨", "Calls") },
                  { value: "put", label: t("看跌", "Puts") },
                ]}
              />
            )}
          </div>
        )}
        {tab === "gamma" && (
          <div className="mx-options-scope">
            {t("全部到期日", "All expirations")}
          </div>
        )}
        <div className="mx-metric-grid mx-option-summary">
          <Metric
            label={t("看跌 / 看涨持仓比", "Put / call open interest")}
            value={number(summary?.putCallOiRatio)}
          />
          <Metric
            label={t("最大痛点", "Max pain")}
            value={optionValue(summary?.maxPain)}
          />
          <Metric
            label={t("看涨持仓墙", "Call wall")}
            value={optionValue(summary?.callWall)}
          />
          <Metric
            label={t("看跌持仓墙", "Put wall")}
            value={optionValue(summary?.putWall)}
          />
        </div>
        {tab === "gamma" ? (
          <>
            <div className="mx-metric-grid" style={{ margin: "24px 0" }}>
              <Metric
                label={t("净 Gamma 敞口", "Net gamma exposure")}
                value={compact(options.netGex)}
              />
              <Metric
                label={t("Gamma 翻转点", "Gamma flip")}
                value={optionValue(options.gammaFlip)}
              />
              <Metric
                label={t("当前价格", "Spot price")}
                value={optionValue(options.spot)}
              />
              <Metric
                label={t("覆盖到期日", "Expirations covered")}
                value={options.expiryCount}
              />
            </div>
            {options.gammaProfile.length ? (
              <Plot
                label={t(
                  "价格变化下的 Gamma 敞口",
                  "Gamma exposure across spot prices",
                )}
                option={(c) => ({
                  xAxis: {
                    type: "value",
                    scale: true,
                    axisLabel: { color: c.axis },
                    splitLine: { show: false },
                  },
                  yAxis: {
                    type: "value",
                    axisLabel: {
                      color: c.axis,
                      formatter: (v: number) => compact(v),
                    },
                    splitLine: { lineStyle: { color: c.grid } },
                  },
                  series: [
                    {
                      type: "line",
                      name: "GEX",
                      data: options.gammaProfile.map((p) => [p.spot, p.netGex]),
                      lineStyle: { color: c.brand, width: 2.5 },
                      itemStyle: { color: c.brand },
                      showSymbol: false,
                      areaStyle: { opacity: 0.06 },
                      markLine: {
                        symbol: "none",
                        data: [
                          { yAxis: 0 },
                          ...[
                            [t("现价", "Spot"), options.spot],
                            [t("翻转点", "Flip"), options.gammaFlip],
                          ]
                            .filter((entry) => typeof entry[1] === "number")
                            .map(([name, value], index) => ({
                              name: String(name),
                              xAxis: Number(value),
                              label: {
                                rotate: 0,
                                position:
                                  index === 0
                                    ? "insideEndTop" as const
                                    : "insideStartTop" as const,
                              },
                            })),
                        ],
                        label: {
                          show: true,
                          formatter: "{b}",
                          position: "insideEndTop",
                          color: c.axis,
                        },
                        lineStyle: { color: c.axis, type: "dashed" },
                      },
                    },
                  ],
                })}
              />
            ) : (
              <Empty
                title={t("Gamma 曲线暂无记录", "Gamma profile unavailable")}
              />
            )}
          </>
        ) : tab === "interest" ? (
          strikes.length ? (
            <>
              <Plot
                label={t(
                  "按行权价比较看涨与看跌持仓",
                  "Call and put open interest by strike",
                )}
                option={(c) => ({
                  xAxis: {
                    type: "category",
                    data: strikes.map(String),
                    axisLabel: { color: c.axis, hideOverlap: true },
                    axisTick: { show: false },
                    axisLine: { show: false },
                  },
                  yAxis: {
                    type: "value",
                    axisLabel: {
                      color: c.axis,
                      formatter: (v: number) => compact(v),
                    },
                    splitLine: { lineStyle: { color: c.grid } },
                  },
                  series: (["call", "put"] as const).map((s, i) => ({
                    type: "bar",
                    name:
                      i === 0
                        ? t("看涨持仓", "Call open interest")
                        : t("看跌持仓", "Put open interest"),
                    data: strikes.map(
                      (strike) =>
                        contracts.find(
                          (c) => c.strike === strike && c.side === s,
                        )?.openInterest ?? null,
                    ),
                    itemStyle: {
                      color: i === 0 ? c.brand : c.accent,
                      borderRadius: [2, 2, 0, 0],
                    },
                    barMaxWidth: 18,
                  })),
                })}
              />
              <Legend
                items={[
                  { label: t("看涨持仓", "Call open interest") },
                  { label: t("看跌持仓", "Put open interest") },
                ]}
              />
            </>
          ) : (
            <Empty
              title={t(
                "这个到期日没有合约快照",
                "No contract snapshot for this expiration",
              )}
            />
          )
        ) : tab === "near" ? (
          <>
            <Group justify="space-between" my="md">
              <span>{t("最近 15 个行权价", "15 nearest strikes")}</span>
              <span>
                {t("现价", "Spot")}: {optionValue(options.spot)}
              </span>
            </Group>
            {nearStrikes.length ? (
              <div
                className="mx-table-wrap"
                role="region"
                tabIndex={0}
                aria-label={t("近价合约对照", "Near-the-money contracts")}
              >
                <table className="mx-table mx-option-chain">
                  <thead>
                    <tr>
                      <th scope="colgroup" colSpan={3}>
                        {t("看涨 · Call", "Calls")}
                      </th>
                      <th colSpan={2} className="mx-strike-heading">
                        {optionCurrency}
                      </th>
                      <th scope="colgroup" colSpan={3}>
                        {t("看跌 · Put", "Puts")}
                      </th>
                    </tr>
                    <tr>
                      {[
                        t("持仓量", "OI"),
                        "Bid / Ask",
                        "IV",
                        t("行权价", "Strike"),
                        t("距现价", "From spot"),
                        "IV",
                        "Bid / Ask",
                        t("持仓量", "OI"),
                      ].map((label, i) => (
                        <th scope="col" key={i}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {nearStrikes.map((strike) => {
                      const call = contracts.find(
                        (contract) =>
                          contract.side === "call" &&
                          contract.strike === strike,
                      );
                      const put = contracts.find(
                        (contract) =>
                          contract.side === "put" && contract.strike === strike,
                      );
                      return (
                        <tr
                          key={strike}
                          className={
                            strike === closest ? "mx-near-spot" : undefined
                          }
                        >
                          <td>{number(call?.openInterest, 0)}</td>
                          <td>
                            {number(call?.bid, 2)} / {number(call?.ask, 2)}
                          </td>
                          <td>{percent(call?.impliedVolatility)}</td>
                          <th scope="row" className="mx-strike">
                            {number(strike, 2)}
                            {strike === closest && (
                              <small>{t("近现价", "Nearest spot")}</small>
                            )}
                          </th>
                          <td className="mx-strike-distance">
                            {percent(
                              options.spot > 0
                                ? strike / options.spot - 1
                                : null,
                              true,
                              1,
                            )}
                          </td>
                          <td>{percent(put?.impliedVolatility)}</td>
                          <td>
                            {number(put?.bid, 2)} / {number(put?.ask, 2)}
                          </td>
                          <td>{number(put?.openInterest, 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={t(
                  "这个到期日暂无近价合约",
                  "No near-the-money contracts for this expiry",
                )}
              />
            )}
          </>
        ) : rows.length ? (
          <>
            <div
              className="mx-table-wrap"
              tabIndex={0}
              role="region"
              aria-label={t("数据表格", "Data table")}
            >
              <table className="mx-table">
                <thead>
                  <tr>
                    <th>{t("方向", "Side")}</th>
                    <th className="mx-align-right">{t("行权价", "Strike")}</th>
                    <th className="mx-align-right">Bid</th>
                    <th className="mx-align-right">Ask</th>
                    <th className="mx-align-right">{t("隐含波动", "IV")}</th>
                    <th className="mx-align-right">
                      {t("持仓量", "Open interest")}
                    </th>
                    <th className="mx-align-right">{t("成交量", "Volume")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((c, i) => (
                    <tr key={c.contractSymbol ?? i}>
                      <td>
                        <Tag tone={c.side === "call" ? "good" : "neutral"}>
                          {c.side === "call"
                            ? t("看涨", "Call")
                            : t("看跌", "Put")}
                        </Tag>
                        {c.inTheMoney && (
                          <small>{t("价内", "In the money")}</small>
                        )}
                      </td>
                      <td className="mx-align-right">
                        <strong>{number(c.strike)}</strong>
                      </td>
                      <td className="mx-align-right">{number(c.bid)}</td>
                      <td className="mx-align-right">{number(c.ask)}</td>
                      <td className="mx-align-right">
                        {percent(c.impliedVolatility)}
                      </td>
                      <td className="mx-align-right">
                        {number(c.openInterest, 0)}
                      </td>
                      <td className="mx-align-right">{number(c.volume, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > limit && (
              <Button
                variant="subtle"
                fullWidth
                mt="md"
                onClick={() => setLimit((n) => n + 40)}
              >
                {t("显示更多合约", "Show more contracts")}
              </Button>
            )}
          </>
        ) : (
          <Empty title={t("没有匹配的合约", "No matching contracts")} />
        )}
      </Panel>
      <details className="mx-panel">
        <summary>{t("如何阅读期权数据", "Reading options data")}</summary>
        <Facts
          rows={[
            [
              t("买价 / 卖价", "Bid / ask"),
              t(
                "买方愿付与卖方愿收的报价，不保证能以该价格成交。",
                "Quoted buying and selling prices; execution is not guaranteed.",
              ),
            ],
            [
              t("持仓量", "Open interest"),
              t(
                "尚未平仓的合约数，与当天成交量不同。",
                "Outstanding contracts, distinct from session trading volume.",
              ),
            ],
            [
              t("隐含波动率", "Implied volatility"),
              t(
                "由期权价格反推的年化波动预期，不表示涨跌方向。",
                "Annualized volatility implied by option prices; it does not indicate direction.",
              ),
            ],
            [
              t("持仓墙", "Open-interest walls"),
              t(
                "看涨或看跌未平仓量最集中的行权价，不是确定的支撑或阻力。",
                "Strikes with the greatest call or put open interest, not guaranteed support or resistance.",
              ),
            ],
            [
              t("最大痛点", "Max pain"),
              t(
                "按现有持仓计算的到期支付最小位置，不是目标价。",
                "The strike minimizing aggregate expiration payout for observed open interest, not a price target.",
              ),
            ],
            [
              t("Gamma 翻转点", "Gamma flip"),
              t(
                "模型估算净 Gamma 改变符号的位置；依赖仓位与定价假设。",
                "Where modeled net gamma changes sign; dependent on position and pricing assumptions.",
              ),
            ],
          ]}
        />
      </details>
    </>
  );
}
