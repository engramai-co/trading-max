"use client";

import { behaviorObservation, reviewLabel, systemReason } from "./review-copy";
import { useState } from "react";
import { Select } from "@mantine/core";
import { Bars, HistoryChart } from "./charts";
import { currency, number, object, objects, percent, str, type Json } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Facts, Notice, Panel, useCopy } from "./foundation";

export const field = (data: Json, key: string): unknown =>
  data[key] ??
  data[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
type Field = [string, string, string, "money" | "percent" | "number" | "text"];
export function DetailFacts({ data, fields }: { data: Json; fields: Field[] }) {
  const t = useCopy();
  return (
    <Facts
      rows={fields.map(([zh, en, key, format]) => {
        const value = field(data, key);
        return [
          t(zh, en),
          format === "money"
            ? currency(value, "GBP", 2)
            : format === "percent"
              ? percent(value, false, 2)
              : format === "number"
                ? number(value)
                : reviewLabel(str(value), t) || "—",
        ];
      })}
    />
  );
}
export function Availability({ data }: { data: Json }) {
  const t = useCopy();
  const reason = str(field(data, "unavailable_reason"));
  const reasons = field(data, "partial_reasons");
  const raw = [reason, ...(Array.isArray(reasons) ? reasons.map(String) : [])].filter(Boolean);
  return <>
    {raw.length ? <SystemNotes values={raw} /> : (data.status === "partial" || data.partial === true) ?
      <Notice tone="warn">{t("记录覆盖不完整。", "Records are partially covered.")}</Notice> : null}
  </>;
}
export function SystemNotes({ values }: { values: string[] }) {
  const t = useCopy();
  const messages = [...new Set(values.filter(Boolean).map((value) => systemReason(value, t)))];
  if (!messages.length) return null;
  return <Notice>
    {messages.map((message) => <p key={message}>{message}</p>)}
    <details className="mx-chart-data">
      <summary>{t("诊断详情", "Diagnostic details")}</summary>
      {values.map((value, i) => <p key={i}>{value}</p>)}
    </details>
  </Notice>;
}
export function BehaviorEvidence({ data, cfd }: { data: Json; cfd: boolean }) {
  const t = useCopy();
  return (
    <Panel
      title={t("交易行为与收益依赖", "Trading behavior and concentration")}
      help={t(
        "只描述记录中可观察的行为，不推断动机。",
        "Observable behavior only; these records do not reveal motives.",
      )}
    >
      <Availability data={data} />
      <DetailFacts
        data={data}
        fields={
          cfd
            ? [
                [
                  "已平仓名义本金",
                  "Closed notional",
                  "total_closed_notional",
                  "money",
                ],
                [
                  "平均名义本金",
                  "Average notional",
                  "average_closed_notional",
                  "money",
                ],
                [
                  "收益 / 名义本金",
                  "Return / notional",
                  "net_realised_to_notional_ratio",
                  "percent",
                ],
                [
                  "融资费用 / 名义本金",
                  "Financing / notional",
                  "financing_cost_to_notional_ratio",
                  "percent",
                ],
                [
                  "缺失本金的交易",
                  "Trades missing notional",
                  "missing_notional_trade_count",
                  "number",
                ],
                [
                  "最佳交易贡献",
                  "Best trade concentration",
                  "best_trade_concentration",
                  "percent",
                ],
                [
                  "前三笔贡献",
                  "Top three concentration",
                  "top_three_trade_concentration",
                  "percent",
                ],
                [
                  "去除最佳交易后",
                  "Without best trade",
                  "net_without_best_trade",
                  "money",
                ],
              ]
            : [
                [
                  "交易总金额",
                  "Gross traded notional",
                  "gross_traded_notional_gbp",
                  "money",
                ],
                ["买单数", "Buy orders", "buy_orders", "number"],
                ["卖单数", "Sell orders", "sell_orders", "number"],
                [
                  "交易时平均持仓数",
                  "Average active positions",
                  "average_active_positions_at_trade_events",
                  "number",
                ],
                [
                  "交易时最多持仓数",
                  "Peak active positions",
                  "peak_active_positions_at_trade_events",
                  "number",
                ],
                [
                  "回撤期间买入",
                  "Purchases during drawdowns",
                  "drawdown_buy_notional_gbp",
                  "money",
                ],
              ]
        }
      />
      {objects(data.observations).map((row, i) => {
        const evidence = object(row.evidence);
        const duration = row.diagnostic === "winner_vs_loser_holding_days";
        const diagnostic = behaviorObservation(str(row.diagnostic), row.value, t);
        // The purchase total already appears above; do not repeat the same fact.
        if (row.diagnostic === "buy_notional_during_money_drawdown_gbp" && row.value === field(data, "drawdown_buy_notional_gbp")) return null;
        return (
          <div className="mx-disclosure" key={i}>
            <strong>
              {diagnostic.label}
            </strong>
            <p>{diagnostic.value}</p>
            {!diagnostic.known && <details><summary>{t("诊断详情", "Diagnostic details")}</summary>{str(row.diagnostic)}</details>}
            {duration ? (
              <DetailFacts
                data={evidence}
                fields={[
                  [
                    "赢家中位天数",
                    "Winner median days",
                    "winner_median_days",
                    "number",
                  ],
                  [
                    "输家中位天数",
                    "Loser median days",
                    "loser_median_days",
                    "number",
                  ],
                ]}
              />
            ) : (
              <p>
                {str(evidence.ticker)}{" "}
                {field(evidence, "result_gbp") != null
                  ? currency(field(evidence, "result_gbp"), "GBP", 2)
                  : ""}
              </p>
            )}
          </div>
        );
      })}
    </Panel>
  );
}
export function StrategyEvidence({ data }: { data: Json }) {
  const t = useCopy();
  return (
    <Panel
      title={t("策略收益与风险", "Strategy returns and risk")}
      help={t("使用全部可用历史的 TWR，剔除出入金影响。", "Uses TWR over the full available history, excluding cash-flow effects.")}
    >
      <Availability data={data} />
      <DetailFacts
        data={object(data.metrics)}
        fields={[
          [
            "时间加权收益",
            "Time-weighted return",
            "twr_total_return",
            "percent",
          ],
          ["年化收益", "Annualized return", "annualized_return", "percent"],
          [
            "年化波动",
            "Annualized volatility",
            "annualized_volatility",
            "percent",
          ],
          ["当前回撤", "Current drawdown", "current_drawdown", "percent"],
          ["最大回撤", "Maximum drawdown", "max_drawdown", "percent"],
          ["Sharpe", "Sharpe", "sharpe_sonia", "number"],
          ["Sortino", "Sortino", "sortino_sonia", "number"],
          ["Calmar", "Calmar", "calmar_ratio", "number"],
          ["信息比率", "Information ratio", "information_ratio", "number"],
          ["比较基准", "Benchmark", "benchmark_ticker", "text"],
          ["有效期间数", "Valid periods", "periods", "number"],
          ["净值数据质量", "NAV quality", "nav_quality", "text"],
        ]}
      />
      <SystemNotes values={Object.values(object(object(data.metrics).metric_unavailable_reasons)).map(String)} />
    </Panel>
  );
}
export function CfdCashEvidence({ review }: { review: Json }) {
  const t = useCopy();
  const pnl = object(review.realisedPnl);
  const cash = object(review.cashFlows);
  const series = objects(review.realisedSeries);
  return (
    <>
      <div className="mx-grid">
        <Panel
          title={t("账户与家庭现金流", "Account and household cash flows")}
        >
          <DetailFacts
            data={cash}
            fields={[
              ["入金", "Deposits", "deposits", "money"],
              ["出金", "Withdrawals", "withdrawals", "money"],
              ["内部转移", "Internal transfers", "internal_transfers", "money"],
              ["调整", "Adjustments", "adjustments", "money"],
              ["账户资金流", "Account cash flow", "account_cash_flow", "money"],
              [
                "家庭外部资金流",
                "Household external flow",
                "household_external_flow",
                "money",
              ],
            ]}
          />
          <Notice>
            {t(
              "账户间转移改变单账户资金，不一定改变家庭外部投入。",
              "Transfers between accounts change account cash flow, but not necessarily household external contributions.",
            )}
          </Notice>
        </Panel>
        <Panel
          title={t("从毛收益到实际结果", "From gross returns to net result")}
        >
          <DetailFacts
            data={pnl}
            fields={[
              [
                "已平仓毛收益",
                "Closed gross result",
                "closed_gross_result",
                "money",
              ],
              ["外汇费用", "FX fees", "fx_fees", "money"],
              ["扣除外汇费用后", "After FX", "closed_after_fx", "money"],
              ["隔夜利息", "Overnight interest", "overnight_interest", "money"],
              [
                "分红调整",
                "Dividend adjustment",
                "dividend_adjustment",
                "money",
              ],
              [
                "已实现净结果",
                "Net realized result",
                "net_realised_pnl",
                "money",
              ],
              [
                "融资拖累 / 毛收益",
                "Financing drag / gross",
                "financing_drag_to_gross_ratio",
                "percent",
              ],
              [
                "融资拖累 / 净收益",
                "Financing drag / net",
                "financing_drag_to_net_ratio",
                "percent",
              ],
            ]}
          />
        </Panel>
      </div>
      <Panel
        title={t("已实现现金权益记录", "Realized cash equity history")}
        help={t("现金权益不含未平仓浮动盈亏。", "Cash equity excludes unrealized P&L on open positions.")}
      >
        <HistoryChart
          label={t("CFD 已实现权益代理", "CFD realized equity proxy")}
          dates={series.map((r) => str(r.occurredAt))}
          lines={[
            {
              name: t("权益代理", "Equity proxy"),
              values: series.map((r) => numeric(r.realisedCashEquityProxy)),
            },
            {
              name: t("累计已实现损益", "Cumulative realized P&L"),
              values: series.map((r) => numeric(r.cumulativeRealisedPnl)),
              colour: "accent",
            },
          ]}
        />
        <EvidenceTable
          rows={series}
          label={t("CFD 事件", "CFD events")}
          columns={[
            { label: t("时间", "Time"), value: (r) => str(r.occurredAt) },
            { label: t("类型", "Type"), value: (r) => reviewLabel(str(r.recordType), t) },
            {
              label: t("资金流变化", "Cash-flow change"),
              value: (r) => currency(r.accountCashFlowChange, "GBP", 2),
              numeric: true,
            },
            {
              label: t("损益变化", "P&L change"),
              value: (r) => currency(r.realisedPnlChange, "GBP", 2),
              numeric: true,
            },
            {
              label: t("累计资金流", "Cumulative cash flow"),
              value: (r) => currency(r.cumulativeAccountCashFlow, "GBP", 2),
              numeric: true,
            },
            {
              label: t("权益代理", "Equity proxy"),
              value: (r) => currency(r.realisedCashEquityProxy, "GBP", 2),
              numeric: true,
            },
            {
              label: t("回撤", "Drawdown"),
              value: (r) => currency(r.realisedPnlDrawdown, "GBP", 2),
              numeric: true,
            },
          ]}
        />
      </Panel>
    </>
  );
}
export function EndingEvidence({ data }: { data: Json }) {
  const t = useCopy();
  const [dimension, setDimension] = useState("country");
  const exposures = object(data.exposures);
  const current = object(exposures[dimension]);
  const rows = objects(current.buckets);
  return (
    <>
      <Panel
        title={t("期末集中度", "Concentration at the review endpoint")}
        help={t(
          "HHI 是持仓权重平方和；越接近 1 越集中。有效持仓数为其倒数。分母为期末已投资市值。",
          "HHI is the sum of squared position weights; closer to 1 means greater concentration. Effective positions is its reciprocal. Weights use invested value at the review endpoint.",
        )}
      >
        <Availability data={data} />
        <DetailFacts
          data={object(data.concentration)}
          fields={[
            ["HHI 集中度", "HHI concentration", "hhi", "number"],
            [
              "有效持仓数",
              "Effective positions",
              "effective_positions",
              "number",
            ],
            ["最大持仓占比", "Largest position", "largest_weight", "percent"],
            [
              "前三持仓占比",
              "Top three positions",
              "top_three_weight",
              "percent",
            ],
          ]}
        />
      </Panel>
      <Panel title={t("期末持仓明细", "Ending holdings")}>
        <EvidenceTable
          label={t("期末持仓", "Ending holdings")}
          rows={objects(data.holdings)}
          columns={[
            { label: t("证券", "Security"), value: (r) => str(r.ticker) },
            {
              label: t("数量", "Quantity"),
              value: (r) => number(r.quantity),
              numeric: true,
            },
            {
              label: t("成本", "Cost"),
              value: (r) => currency(field(r, "total_cost_gbp")),
              numeric: true,
            },
            {
              label: t("市值", "Value"),
              value: (r) => currency(field(r, "current_value_gbp")),
              numeric: true,
            },
            {
              label: t("未实现盈亏", "Unrealized P&L"),
              value: (r) => currency(field(r, "unrealized_pnl_gbp")),
              numeric: true,
            },
            {
              label: t("持仓权重", "Invested weight"),
              value: (r) => percent(r.weight),
              numeric: true,
            },
          ]}
        />
      </Panel>
      <Panel
        title={t("这个账户的期末敞口", "This account’s ending exposures")}
        action={
          <Select
            aria-label={t("期末敞口维度", "Ending exposure dimension")}
            value={dimension}
            onChange={(v) => setDimension(v ?? "country")}
            data={[
              { value: "country", label: t("国家", "Country") },
              { value: "industry", label: t("行业", "Industry") },
              { value: "currency", label: t("币种", "Currency") },
              { value: "direction", label: t("方向", "Direction") },
            ]}
          />
        }
      >
        <Availability data={current} />
        <Bars
          label={t("期末敞口金额", "Ending exposure value")}
          labels={rows.slice(0, 12).map((r) => reviewLabel(str(r.label), t))}
          values={rows.slice(0, 12).map((r) => numeric(field(r, "value_gbp")))}
        />
        <EvidenceTable
          key={dimension}
          label={t("全部期末敞口", "All ending exposures")}
          rows={rows}
          columns={[
            { label: t("分类", "Category"), value: (r) => reviewLabel(str(r.label), t) },
            {
              label: t("金额", "Value"),
              value: (r) => currency(field(r, "value_gbp")),
              numeric: true,
            },
            {
              label: t("权重", "Weight"),
              value: (r) => percent(r.weight),
              numeric: true,
            },
          ]}
        />
      </Panel>
    </>
  );
}
