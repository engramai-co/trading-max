"use client";

import { type ReactNode, useId } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { percent } from "./data";
import { Panel, Tag, useCopy } from "./foundation";
import { accountName, useWorkspaceProfile } from "./profile";

type Evidence = components["schemas"]["InvestmentReviewEvidence"];
type Account = "A" | "B";
type Fill = components["schemas"]["FillEffect"];

const VISIBLE_OBSERVATIONS = 4;

export function ReviewDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="mx-review-disclosure">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

type Observation = (
  | { kind: "move"; row: components["schemas"]["HoldingMove"] }
  | { kind: "cash"; row: components["schemas"]["CashSpan"] }
  | { kind: "drift"; row: components["schemas"]["WeightDrift"] }
) & { account: Account; date: string };

export function orderReviewObservations(data: Evidence): Observation[] {
  const rows: Observation[] = [];
  for (const account of ["A", "B"] as const) {
    const evidence = data.accounts[account];
    if (!evidence) continue;
    for (const row of evidence.holdingMoves ?? []) rows.push({ kind: "move", account, date: row.date, row });
    for (const row of evidence.cashSpans ?? []) rows.push({ kind: "cash", account, date: row.end, row });
    for (const row of evidence.weightDrifts ?? []) rows.push({ kind: "drift", account, date: row.end, row });
  }
  // A volatile week should not push both slower observations out of the preview.
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const first = (["move", "cash", "drift"] as const).map((kind) => rows.find((row) => row.kind === kind));
  return [...rows.filter((row) => first.includes(row)), ...rows.filter((row) => !first.includes(row))];
}

const share = (value: number) => percent(value, false, 1);
const percentage = (value: number) => Number((value * 100).toFixed(4));

export function shortMoveBasis(row: components["schemas"]["HoldingMove"], locale: "zh" | "en") {
  if (row.basis !== "short_history" || row.threshold == null) return null;
  const floor = percentage(row.threshold) + "%";
  return locale === "zh" ? `历史不足，采用 ${floor} 阈值` : `Limited history · ${floor} floor`;
}

export function fillRows(data: Evidence) {
  return (["A", "B"] as const)
    .flatMap((account) => (data.accounts[account]?.fillEffects ?? []).map((row) => ({ account, row })))
    .sort((a, b) => Date.parse(b.row.filledAt) - Date.parse(a.row.filledAt));
}

function Observations({ rows, showAccount }: { rows: Observation[]; showAccount: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  return (
    <ul className="mx-review-observations">
      {rows.map((item, index) => {
        const { account, date, kind, row } = item;
        const name = showAccount ? accountName(profile, account) : undefined;
        if (kind === "move") {
          return (
            <li key={index}>
              <div>
                <strong>{row.change > 0 ? t("持仓上涨", "Holding rose") : t("持仓下跌", "Holding fell")}</strong>
                <small>{[formatCalendarDate(date, locale), name, row.ticker, shortMoveBasis(row, locale)].filter(Boolean).join(" · ")}</small>
              </div>
              <span className={row.change > 0 ? "mx-up" : "mx-down"}>{percent(row.change, true, 1)}</span>
            </li>
          );
        }
        const span = formatDateSpan(row.start, row.end, locale);
        return (
          <li key={index}>
            <div>
              <strong>{kind === "cash" ? t("现金占比", "Sustained cash share") : t("持仓权重漂移", "Weight drift")}</strong>
              <small>{[span, name, kind === "cash"
                ? (locale === "zh" ? `${row.sessions} 个交易日` : `${row.sessions} trading days`)
                : row.ticker].filter(Boolean).join(" · ")}</small>
            </div>
            {kind === "cash" ? (
              <span>
                {share(row.peakShare)} <small>{t("峰值", "peak")}</small>
                <small>{share(row.averageShare)} {t("平均", "average")}</small>
              </span>
            ) : (
              <span>{share(row.before)} <ArrowRight size={13} aria-label={t("至", "to")} /> {share(row.after)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FillComparison({ row, account, collapsed = false }: { row: Fill; account?: string; collapsed?: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const id = useId();
  const time = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(row.filledAt));
  const action = row.side === "buy" ? t("买入", "Bought") : t("卖出", "Sold");
  const caption = <>
    <time dateTime={row.filledAt}>{time}</time>
    {" · " + [account, `${action} ${row.ticker}`, locale === "zh" ? `${row.quantity} 股` : `${row.quantity} shares`].filter(Boolean).join(" · ")}
  </>;
  const comparisons = [
    ["largestHolding", t("最大持仓占比", "Largest holding")],
    ["cash", t("现金占比", "Cash share")],
    ["usdExposure", t("美元计价敞口", "USD-denominated exposure")],
  ] as const;
  const table = (
    <table className="mx-review-fill-table" aria-labelledby={id}>
      <thead>
        <tr>
          <td />
          <th scope="col">{t("成交前", "Before")}</th>
          <td />
          <th scope="col">{t("成交后", "After")}</th>
        </tr>
      </thead>
      <tbody>{comparisons.map(([key, label]) => (
        <tr key={key}>
          <th scope="row">{label}</th>
          <td>{share(row.before[key])}</td>
          <td aria-hidden="true"><ArrowRight size={13} /></td>
          <td>{share(row.after[key])}</td>
        </tr>
      ))}</tbody>
    </table>
  );
  return collapsed ? (
    <details className="mx-review-disclosure mx-review-fill-more">
      <summary id={id}><span>{caption}</span></summary>
      {table}
    </details>
  ) : (
    <div className="mx-review-fill">
      <p className="mx-review-fill-context" id={id}>{caption}</p>
      {table}
    </div>
  );
}

export function ReviewObservations({ data, showAccount = true }: { data: Evidence; showAccount?: boolean }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { locale } = useLocale();
  const observations = orderReviewObservations(data);
  const fills = fillRows(data);
  const { rules } = data;
  const volatility = rules.sessionMoveVolatility;
  const partial = Object.values(data.accounts).some((value) => value.coverage === "partial");
  const caveat = partial && <Tag>{t("覆盖不全", "Partial coverage")}</Tag>;
  const coverage = partial && <p>{t(
    "缺少价格、汇率或可核对的交易记录时，相关记录不显示。",
    "Rows are omitted when prices, FX or reconciled ledger records are missing.",
  )}</p>;
  return (
    <div className="mx-grid mx-review-observation-grid">
      <Panel title={t("没操作", "No trades")} action={caveat} help={
        <>
          <p>{volatility ? (locale === "zh"
            ? `最近 ${rules.evidenceDays} 天：当天没有买卖，且收盘涨跌幅的绝对值达到 ${percentage(rules.sessionMoveShare)}% 或波动阈值中的较高者。波动阈值为该持仓过去 ${volatility.lookbackSessions} 个交易日的日收益率样本标准差的 ${volatility.multiple} 倍，不计当天。可用日收益率不足 ${volatility.minReturns} 个时采用 ${percentage(rules.sessionMoveShare)}%。每个账户的每只持仓只显示最近 ${volatility.maxRowsPerHolding} 条。价格按证券报价币种计算，并已调整拆股影响。`
            : `Over the last ${rules.evidenceDays} days, a move between consecutive closes qualifies if there was no trade that day and its absolute size reached the higher of ${percentage(rules.sessionMoveShare)}% or ${volatility.multiple} × the sample standard deviation of that holding’s daily returns over the prior ${volatility.lookbackSessions} trading sessions, excluding that day. With fewer than ${volatility.minReturns} usable daily returns, the ${percentage(rules.sessionMoveShare)}% floor applies. Shows up to ${volatility.maxRowsPerHolding} latest moves per holding per account. Prices are split-adjusted and measured in the security’s quote currency.`)
            : (locale === "zh"
              ? `最近 ${rules.evidenceDays} 天：持仓在连续两次收盘之间涨跌至少 ${percentage(rules.sessionMoveShare)}%，且当天没有买卖。`
              : `Over the last ${rules.evidenceDays} days: a holding moved at least ${percentage(rules.sessionMoveShare)}% between consecutive closes with no trade that day.`)}</p>
          <p>{locale === "zh"
            ? `现金占比连续至少 ${rules.cashMinSessions} 个伦敦交易日达到 ${percentage(rules.cashShare)}%。持仓权重在 ${rules.weightDriftDays} 个自然日内变动至少 ${percentage(rules.weightDriftShare)} 个百分点，期间没有买卖；每只持仓显示最大变动。两者均以日末账户总值（含现金）为分母。`
            : `Cash accounted for at least ${percentage(rules.cashShare)}% for ${rules.cashMinSessions} consecutive London trading days. A holding’s weight changed at least ${percentage(rules.weightDriftShare)} percentage points within ${rules.weightDriftDays} calendar days with no trades; the largest change per holding is shown. Both shares use end-of-day account value including cash.`}</p>
          {coverage}
        </>
      }>
        {observations.length ? <Observations rows={observations.slice(0, VISIBLE_OBSERVATIONS)} showAccount={showAccount} /> : (
          <p className="mx-review-empty">{partial ? t("暂无可核对的观察记录", "No verifiable observations yet") : t("近期没有符合规则的记录", "No recent observations matched")}</p>
        )}
        {observations.length > VISIBLE_OBSERVATIONS && (
          <ReviewDisclosure label={t("更多记录", "More observations")}>
            <Observations rows={observations.slice(VISIBLE_OBSERVATIONS)} showAccount={showAccount} />
          </ReviewDisclosure>
        )}
      </Panel>
      <Panel title={t("交易副作用", "Trade side effects")} action={caveat} help={
        <>
          <p>{locale === "zh"
            ? `每个账户显示最近 ${rules.evidenceDays} 天内最多 ${rules.recentFillLimit} 笔成交。按成交时已完成的最近收盘价和日汇率，在同一时点重算成交前后占比。美元计价敞口只计入以 USD 报价的证券，不穿透基金；三项占比均以账户总值（含现金）为分母。`
            : `Shows up to ${rules.recentFillLimit} fills per account in the last ${rules.evidenceDays} days. Before and after shares use the same latest completed closes and daily FX at the fill time. USD exposure counts securities quoted in USD without looking through funds. All shares use total account value including cash.`}</p>
          {coverage}
        </>
      }>
        {fills.length ? fills.map(({ account, row }, index) => (
          <FillComparison key={account + ":" + row.filledAt} row={row}
            account={showAccount ? accountName(profile, account) : undefined} collapsed={index > 0} />
        )) : (
          <p className="mx-review-empty">{partial ? t("暂无可重算的成交", "No fills can be repriced yet") : t("近期没有成交", "No recent fills")}</p>
        )}
      </Panel>
    </div>
  );
}
