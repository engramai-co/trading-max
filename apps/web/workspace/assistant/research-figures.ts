import type { Locale } from "@/components/locale-provider";
import { formatDateTime } from "@/ui/formatters";
import { currency, number, object, objects, percent, str, type Json } from "../data";
import { calendarObservation } from "./figures";
import type { Evidence } from "./evidence";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isoDay = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(str(value)) ? str(value) : "";
function nativeMoney(n: unknown, unit: unknown, digits = 2) {
  if (!finite(n)) return "";
  if (["GBp", "GBx", "GBX"].includes(str(unit))) return number(n, 4) + " GBp";
  return /^[A-Z]{3}$/.test(str(unit)) ? currency(n, str(unit), digits) : "";
}

export type ResearchFigure = { text: string; evidence: Evidence };

const eventLabels: Record<string, [zh:string,en:string,source:Evidence["source"],lens:string]> = {
  earnings:["财报","Earnings reported","financials","analyst"], rating_change:["评级变动","Rating change","analysts","analyst"],
  ex_dividend:["除息日","Ex-dividend date","disclosure","technical"], dividend_pay:["派息日","Dividend payment date","disclosure","technical"],
  dividend:["已披露股息","Reported dividend","disclosure","technical"], filing:["监管披露","Regulatory filing","disclosure","ledger"],
  own_trade:["账户成交","Account trade","broker","technical"], macro:["官方发布","Official release","calendar","overview"],
  holiday:["休市日","Market holiday","calendar","overview"],half_day:["提前收市","Early close","calendar","overview"],
};

function basisName(basis: unknown, locale: Locale) {
  const words = basis === "split-and-dividend-adjusted" ? ["拆股及股息调整后回报","Split- and dividend-adjusted return"]
    : basis === "index-level" ? ["指数点位变动","Index level change"] : ["图表收盘价变动","Change in chart closes"];
  return words[locale === "zh" ? 0 : 1];
}

/** Return undefined for tools owned by the general renderer, null for an unsupported research field. */
export function researchFigure(ref: Evidence, output: Json, path: string, locale: Locale, timeZone: string): ResearchFigure | null | undefined {
  const { tool } = ref;
  const eventsTool = tool === "news_and_events" || tool === "upcoming_events";
  if (!eventsTool && !["research_position", "price_key_moments", "research_earnings", "research_headline"].includes(tool)) return undefined;
  if (path === "/status" || path === "/data/coverage") return undefined;
  const data = object(output.data);
  const ticker = str(data.listing) || str(data.ticker) || str(ref.arguments?.ticker);
  if (!ticker && !eventsTool) return null;
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const figure = (values: string[], source: Evidence["source"], args: Record<string, string>) => ({
    text: [ticker, ...values].filter(Boolean).join(" · "),
    evidence: {...ref, source, arguments: {...ref.arguments, ticker:str(ref.arguments?.ticker) || ticker, field:path, ...(tool === "price_key_moments" && !ref.arguments?.date ? {unselected:"1"} : {}), snapshotId:str(output.snapshot_id) || str(ref.arguments?.snapshotId), ...args}},
  });
  if (eventsTool) {
    const selected = /^\/data\/items\/(0|[1-9]\d?)\/(title_en|title_zh|date)$/.exec(path);
    if (!selected) return undefined;
    const events = objects(data.items);
    const row = ref.arguments?.eventId ? events.find(event => event.evidence_id === ref.arguments?.eventId)
      : events[Number(selected[1])];
    const kind = str(row?.kind);
    if (!row || !Object.hasOwn(eventLabels,kind) || !str(row.evidence_id)) return null;
    const index = events.indexOf(row);
    return calendarObservation(ref, output, "/data/items/" + index + "/" + selected[2], locale, timeZone);
  }

  function priceEvent(event: Json) {
    const kind = str(event.kind), date = isoDay(event.date), id = str(event.reference);
    if (!Object.hasOwn(eventLabels,kind) || !date || !id) return null;
    const [zh,en,source,lens] = eventLabels[kind];
    return figure([date, t(zh,en), ["rating_change","filing","own_trade"].includes(kind) ? id : ""],source,
      {date,lens,event:kind,eventId:id,indexRange:str(data.index_range)});
  }

  if (tool === "research_headline") {
    if (path !== "/data/title" || !str(data.title) || !str(data.publisher)) return null;
    const day = isoDay(data.date) || (str(data.date).includes("T") && Number.isFinite(Date.parse(str(data.date))) ? formatDateTime(str(data.date), locale, timeZone) : "");
    return day ? figure([day, t("相关报道", "Related headline") + " · " + str(data.title)], "publisher", {reference:str(ref.arguments?.reference) || str(data.reference),role:"lead"}) : null;
  }
  if (tool === "price_key_moments") {
    const nested = /^\/data\/items\/(0|[1-9]\d?)\/events\/(0|[1-9]\d?)\/(kind|date|reference)$/.exec(path);
    if (nested) {
      const events = objects(objects(data.items)[Number(nested[1])]?.events);
      const event = ref.arguments?.eventId ? events.find(e => e.reference === ref.arguments?.eventId && e.kind === ref.arguments?.event)
        : events[Number(nested[2])];
      return priceEvent(event ?? {});
    }
    const after = /^\/data\/following\/(0|[1-9]\d?)\/return_fraction$/.exec(path);
    if (after) {
      const row = objects(data.following)[Number(after[1])];
      if (!row || !isoDay(row.start) || !isoDay(row.date) || !finite(row.return_fraction)) return null;
      return figure([str(row.start) + " – " + str(row.date), basisName(data.adjustment,locale) + " " + percent(row.return_fraction,true,2)],
        "market",{date:str(row.start),lens:"technical",indexRange:str(data.index_range)});
    }
    const match = /^\/data\/items\/(0|[1-9]\d?)\/(move_fraction|volume_z_score)$/.exec(path);
    if (!match) return null;
    const item = objects(data.items)[Number(match[1])];
    const day = isoDay(item?.date);
    const value = item?.[match[2]];
    if (!day || !finite(value)) return null;
    const move = match[2] === "move_fraction";
    const metric = move ? basisName(data.adjustment,locale) + " " + percent(value, true, 2)
      : t("成交量较此前 20 个交易日均值的偏差", "Volume deviation from the prior 20-session mean") + " " + number(value) + " σ";
    return figure([day, metric], move ? "market" : "technical", {date:day, lens:"technical", indexRange:str(data.index_range)});
  }
  if (tool === "research_position") {
    const end = isoDay(data.end), start = isoDay(data.start);
    if (!end) return null;
    if (path === "/data/event/date") return priceEvent(object(data.event));
    if (path === "/data/sector_comparison" && ["unavailable","unmapped"].includes(str(data.sector_comparison))) {
      return figure([data.sector_comparison === "unmapped" ? t("暂无已核实的行业基准映射","No verified sector benchmark mapping")
        : t("行业基准缺少同期同币种数据","Insufficient matched sector data in the chart currency")],"technical",{lens:"technical",date:end});
    }
    const quote = data.unit === "points" && finite(data.close) ? number(data.close) + t(" 点", " index points") : nativeMoney(data.close, data.currency);
    const chart = {lens:"technical", date:end, indexRange:str(data.range)};
    if (path === "/data/close" && quote) return figure([end, t("收盘", "Close") + " " + quote], "market", chart);
    if (path === "/data/change" && start && finite(data.change)) return figure([start + " – " + end,
      basisName(data.unit === "points" ? "index-level" : data.adjustment,locale) + " " + percent(data.change, true, 2)], "market", chart);
    const day = isoDay(data.trade_date);
    if (path === "/data/trade_date" && day && ["buy", "sell", "trade"].includes(str(data.side))) {
      return figure([day, data.side === "buy" ? t("最近一笔已核实买入", "Latest verified buy") : data.side === "sell" ? t("最近一笔已核实卖出", "Latest verified sell") : t("最近已核实的成交日", "Latest verified trading day")], "broker", {...chart, date:day});
    }
    const match = /^\/data\/benchmarks\/(0|[1-9]\d?)\/(asset|benchmark)$/.exec(path);
    if (!match) return null;
    const row = objects(data.benchmarks)[Number(match[1])], value = row?.[match[2]];
    if (!row || !str(row.symbol) || !Number.isSafeInteger(row.sessions) || !finite(value)) return null;
    const subject = match[2] === "asset" ? ticker : str(row.name) || str(row.symbol);
    if (!isoDay(row.start) || !isoDay(row.end)) return null;
    const basis = match[2] === "benchmark" && row.benchmark_basis === "price-index" ? "index-level" : "split-and-dividend-adjusted";
    return figure([str(row.start) + " – " + str(row.end), basisName(basis,locale), subject + " · " + str(data.currency) + " · " + number(row.sessions, 0) +
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
  const changed = /^\/data\/changes\/(0|[1-9]\d?)\/change$/.exec(path);
  if (changed) {
    const row = objects(data.changes)[Number(changed[1])];
    if (!row || !["eps","revenue"].includes(str(row.metric))) return null;
    const oldDate = isoDay(str(row.previous_as_of).slice(0,10)), newDate = isoDay(str(row.current_as_of).slice(0,10));
    if (!finite(row.change) || row.change === 0) return null;
    const digits = Math.min(8, Math.max(2, -Math.floor(Math.log10(Math.abs(row.change)))));
    const previous = nativeMoney(row.previous,row.currency,digits), current = nativeMoney(row.current,row.currency,digits);
    const change = nativeMoney(row.change,row.currency,digits);
    if (!oldDate || !newDate || !previous || !current || !change || !isoDay(row.end)) return null;
    return figure([str(row.end), row.metric === "eps" ? t("每股收益一致预期","Consensus EPS per share") : t("营收一致预期","Consensus revenue"),
      oldDate + " · " + previous, newDate + " · " + current, t("变动 ", "Change ") + change],"analysts",{lens:"analyst",analystView:"forecast"});
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
