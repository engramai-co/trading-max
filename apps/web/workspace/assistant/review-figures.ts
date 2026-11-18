import type { Locale } from "@/components/locale-provider";
import { currency, number, object, percent, str, type Json } from "../data";

type Copy = (zh: string, en: string) => string;
const day = (value: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(value)) ? str(value) : "");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;

function account(scope: unknown, t: Copy) {
  if (scope === "invest") return t("投资账户", "Invest");
  if (scope === "isa") return "ISA";
  if (scope === "broker_total") return t("全部投资账户", "All investment accounts");
  return "";
}

function habitField(key: string, field: string, group: Json, t: Copy) {
  const name =
    key === "before_earnings"
      ? t("财报前一周买入", "Buys in the week before earnings")
      : key === "basket_buy"
        ? t("同一天买入多只", "Same-day purchases of multiple securities")
        : t("持仓大跌当天没加仓", "Large falls without a trade");
  const total = group.count,
    measured = group.evaluated;
  if (!count(total) || !count(measured) || measured > total) return null;
  const subset = t("已计 {n}", "{n} measured").replace("{n}", `${measured}/${total}`);
  if (field === "count" || field === "evaluated") {
    const unit = total === 1 ? t("次", "occurrence") : t("次", "occurrences");
    return [name, field === "count" ? `${total} ${unit}` : subset];
  }
  const value = group[field];
  if (!finite(value) || !measured) return null;
  if (field === "mean_return") return [name, t("平均回报", "Mean return"), percent(value, true), subset];
  if (key === "untraded_fall") {
    const label =
      value >= 0
        ? t("事后看，错过约", "In hindsight, missed gains of about")
        : t("事后看，避开约", "In hindsight, avoided losses of about");
    return [
      name,
      label + " " + currency(Math.abs(value), "GBP", 2),
      t("按各自平均买单", "At each security’s average purchase size"),
      subset,
    ];
  }
  return [name, t("合计影响", "Total effect"), currency(value, "GBP", 2), subset];
}

function decisionField(row: Json, field: string, hindsight: boolean, t: Copy): string[] | null {
  const source = hindsight ? object(row.hindsight) : row;
  const value = source[field];
  if (hindsight) {
    const end = day(source.window_end);
    if (!end) return null;
    const prefix = t("事后看", "In hindsight");
    const action =
      row.side === "buy"
        ? t("最佳买入收盘日", "Best closing buy date")
        : t("最佳卖出收盘日", "Best closing sell date");
    if (field === "best_date" && day(value)) return [prefix, action, day(value), t("截至", "Through") + " " + end];
    if (!finite(value)) return null;
    const labels: Record<string, string> = {
      best_close_gbp: t("最佳收盘价（每股）", "Best close per share"),
      missed_gbp: t("按此前平均买单的时点差额约", "Timing gap at the average purchase size, about"),
      average_order_gbp: t("截至成交日的平均买单", "Mean purchase size through the trade"),
    };
    return Object.hasOwn(labels, field)
      ? [
          prefix,
          labels[field],
          currency(value, "GBP", field === "best_close_gbp" ? 4 : 2),
          t("截至", "Through") + " " + end,
        ]
      : null;
  }
  if (field === "date" && day(value)) return [t("成交日", "Trade date"), day(value)];
  if (!finite(value)) return null;
  switch (field) {
    case "prior_close_gbp":
      return day(row.prior_close_date)
        ? [
            t("此前复权收盘价（每股）", "Prior split-adjusted close per share"),
            currency(value, "GBP", 4),
            day(row.prior_close_date),
          ]
        : null;
    case "settled_per_share_gbp":
      return [t("每股结算金额", "Settlement per share"), currency(value, "GBP", 4)];
    case "security_return":
      return [t("标的回报", "Security return"), percent(value, true)];
    case "market_return":
      return [t("同期标普 500 回报（英镑）", "Matched S&P 500 return in GBP"), percent(value, true)];
    case "effect_gbp":
      return [t("决策影响", "Decision effect"), currency(value, "GBP", 2)];
    case "observed_days":
      return count(value) ? [t("已观察交易日", "Observed trading days"), number(value, 0)] : null;
    default:
      return null;
  }
}

const habitPath =
  /^\/data\/groups\/(before_earnings|basket_buy|untraded_fall)\/(count|evaluated|effect_gbp|mean_return)$/;
const decisionPath = /^\/data\/items\/(0|[1-9]\d{0,4})\/(hindsight\/)?([a-z_]+)$/;

export function reviewFieldLocation(tool: string, output: Json, pointer: string): Record<string, string> | null {
  const data = object(output.data);
  if (tool === "review_patterns") {
    const habit = habitPath.exec(pointer)?.[1];
    return habit ? { scope: str(output.scope), horizon: str(data.horizon), habit } : null;
  }
  if (tool !== "decision_timing_and_habits") return null;
  const index = decisionPath.exec(pointer)?.[1];
  if (!index || !Array.isArray(data.items)) return null;
  const row = object(data.items[Number(index)]);
  return {
    scope: str(row.scope),
    horizon: str(row.horizon),
    side: str(row.side),
    ticker: str(row.ticker),
    decision_date: day(row.date),
    ordinal: String(row.ordinal),
  };
}

/** Only the cited, completed tool result can supply the subject, amount and coverage. */
export function renderReviewField(tool: string, output: Json, pointer: string, locale: Locale) {
  const t: Copy = (zh, en) => (locale === "en" ? en : zh);
  const data = object(output.data);
  if (data.currency !== "GBP" || (output.status !== "ok" && output.status !== "partial")) return null;
  const habit = habitPath.exec(pointer);
  const decision = decisionPath.exec(pointer);
  let scope = str(output.scope);
  let horizon = data.horizon;
  let terms: string[] | null = null;
  if (tool === "review_patterns" && habit) {
    const [, key, field] = habit;
    terms = habitField(key, field, object(object(data.groups)[key]), t);
  } else if (tool === "decision_timing_and_habits" && decision && Array.isArray(data.items)) {
    const [, index, hindsight, field] = decision;
    const row = object(data.items[Number(index)]);
    if (!str(row.ticker) || !day(row.date) || !["buy", "sell"].includes(str(row.side))) return null;
    scope = str(row.scope);
    horizon = row.horizon;
    terms = decisionField(row, field, Boolean(hindsight), t);
    if (terms)
      terms.unshift(str(row.ticker), day(row.date), row.side === "buy" ? t("买入", "Buy") : t("卖出", "Sell"));
  }
  if (!terms || !account(scope, t)) return null;
  const window =
    horizon === "20_sessions"
      ? t("20 个交易日", "20 trading days")
      : horizon === "to_date"
        ? t("至今", "To date")
        : "";
  if (!window) return null;
  const dates = object(data.as_of);
  const asOf = (scope === "broker_total" ? ["invest", "isa"] : [scope]).flatMap((code) =>
    day(dates[code]) ? [(scope === "broker_total" ? account(code, t) + " " : "") + day(dates[code])] : [],
  );
  const issues = object(output.quality).issues;
  if (!asOf.length) return null;
  const limited = output.status === "partial" || (Array.isArray(issues) && issues.length > 0);
  return [
    account(scope, t),
    ...terms,
    window,
    t("截至", "As of") + " " + asOf.join(" / "),
    limited ? t("覆盖不完整", "Limited coverage") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
