import type { Locale } from "@/components/locale-provider";
import { formatDateTime } from "@/ui/formatters";
import { currency, number, object, objects, percent, str, type Json } from "../data";
import type { Evidence } from "./evidence";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isoDay = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(str(value)) ? str(value) : "";
function nativeMoney(n: unknown, unit: unknown) {
  if (!finite(n)) return "";
  if (["GBp", "GBx", "GBX"].includes(str(unit))) return number(n, 4) + " GBp";
  return /^[A-Z]{3}$/.test(str(unit)) ? currency(n, str(unit), 2) : "";
}

export type ResearchFigure = { text: string; evidence: Evidence };

/** Return undefined for tools owned by the general renderer, null for an unsupported research field. */
export function researchFigure(ref: Evidence, output: Json, path: string, locale: Locale, timeZone: string): ResearchFigure | null | undefined {
  const { tool } = ref;
  if (!["research_position", "price_key_moments", "research_earnings", "research_headline"].includes(tool)) return undefined;
  if (path === "/status" || path === "/data/coverage") return undefined;
  const data = object(output.data);
  const ticker = str(data.listing) || str(data.ticker) || str(ref.arguments?.ticker);
  if (!ticker) return null;
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const figure = (values: string[], source: Evidence["source"], args: Record<string, string>) => ({
    text: [ticker, ...values].join(" · "),
    evidence: {...ref, source, arguments: {...ref.arguments, ticker, ...args}},
  });
  if (tool === "research_headline") {
    if (path !== "/data/title" || !str(data.title) || !str(data.publisher)) return null;
    const day = isoDay(data.date) || (str(data.date).includes("T") && Number.isFinite(Date.parse(str(data.date))) ? formatDateTime(str(data.date), locale, timeZone) : "");
    return day ? figure([day, t("同日报道", "Also reported") + " · " + str(data.title)], "publisher", {}) : null;
  }
  if (tool === "price_key_moments") {
    const match = /^\/data\/items\/(0|[1-9]\d?)\/(move_fraction|volume_z_score)$/.exec(path);
    if (!match) return null;
    const item = objects(data.items)[Number(match[1])];
    const day = isoDay(item?.date);
    const value = item?.[match[2]];
    if (!day || !finite(value)) return null;
    const move = match[2] === "move_fraction";
    const metric = move ? t("较前一收盘变动", "Change from previous close") + " " + percent(value, true, 2)
      : t("成交量较此前 20 个交易日均值的偏差", "Volume deviation from the prior 20-session mean") + " " + number(value) + " σ";
    return figure([day, metric], move ? "market" : "technical", {date:day, lens:"technical", indexRange:str(data.index_range)});
  }
  if (tool === "research_position") {
    const end = isoDay(data.end), start = isoDay(data.start);
    if (!end) return null;
    const quote = data.unit === "points" && finite(data.close) ? number(data.close) + t(" 点", " index points") : nativeMoney(data.close, data.currency);
    const chart = {lens:"technical", date:end, indexRange:str(data.range)};
    if (path === "/data/close" && quote) return figure([end, t("收盘", "Close") + " " + quote], "market", chart);
    if (path === "/data/change" && start && finite(data.change)) return figure([start + " – " + end,
      t("收盘价变动", "Close-to-close change") + " " + percent(data.change, true, 2)], "market", chart);
    const day = isoDay(data.trade_date);
    if (path === "/data/trade_date" && day && ["buy", "sell"].includes(str(data.side))) {
      return figure([day, data.side === "buy" ? t("最近一笔已核实买入", "Latest verified buy") : t("最近一笔已核实卖出", "Latest verified sell")], "broker", {...chart, date:day});
    }
    const match = /^\/data\/benchmarks\/(0|[1-9]\d?)\/(asset|benchmark)$/.exec(path);
    if (!match) return null;
    const row = objects(data.benchmarks)[Number(match[1])], value = row?.[match[2]];
    if (!row || !str(row.symbol) || !Number.isSafeInteger(row.sessions) || !finite(value)) return null;
    const subject = match[2] === "asset" ? ticker : str(row.symbol);
    return figure([end, subject + " · " + str(data.currency) + " · " + number(row.sessions, 0) +
      t(" 个共同交易日", " matched sessions") + " · " + percent(value, true, 2)], "technical", chart);
  }
  const report = object(data.report), day = isoDay(str(report.date).slice(0,10));
  const reportField = /^\/data\/report\/(actual|estimate|surprise|date)$/.exec(path)?.[1];
  if (reportField && day && str(report.id)) {
    const event = {lens:"analyst", event:"earnings", eventId:str(report.id), date:day};
    if (reportField === "date") return figure([day, t("已公布业绩", "Results reported")], "financials", event);
    if (reportField === "surprise") return finite(report.surprise)
      ? figure([day, t("每股收益相对预期", "EPS surprise") + " " + percent(report.surprise, true, 2)], "financials", event) : null;
    const amount = nativeMoney(report[reportField], report.currency);
    return amount ? figure([day, (reportField === "actual" ? t("已公布每股收益", "Reported EPS") : t("预期每股收益", "Estimated EPS")) +
      " " + amount + t("/股", "/share")], "financials", event) : null;
  }
  const index = /^\/data\/estimates\/(0|[1-9]\d?)\/mean$/.exec(path)?.[1];
  if (index === undefined) return null;
  const estimate = objects(data.estimates)[Number(index)];
  if (!estimate || !["eps", "revenue"].includes(str(estimate.metric))) return null;
  const end = isoDay(estimate.end), asOf = isoDay(str(data.as_of).slice(0,10));
  const amount = nativeMoney(estimate.mean, estimate.currency);
  if (!end || !asOf || !amount || !["0q", "+1q", "0y", "+1y"].includes(str(estimate.period))) return null;
  const period = str(estimate.period).endsWith("q") ? t("季度截止日 ", "Quarter ending ") : t("年度截止日 ", "Year ending ");
  const eps = estimate.metric === "eps";
  return figure([t("截至 ", "As of ") + asOf, period + end, (eps ? t("每股收益一致预期 ", "Consensus EPS ") :
    t("营收一致预期 ", "Consensus revenue ")) + amount + (eps ? t("/股", "/share") : "")],
    "analysts", {lens:"analyst", analystView:"forecast"});
}
