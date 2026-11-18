import type { Locale } from "@/components/locale-provider";
import type { ResearchFigure } from "./research-figures";
import type { Evidence } from "./evidence";
import { formatDateTime, formatDateTimeInTimeZone } from "@/ui/formatters";
import { numeric } from "@/lib/numeric";
import { currency, number, object, objects, percent, str, type Json } from "../data";

type Words = readonly [en: string, zh: string];
const word = (words: Words, locale: Locale) => words[locale === "en" ? 0 : 1];

// Only fields with a known unit can be selected. The model supplies neither
// the metric label nor any surrounding words. New tool schemas extend this table.
const labels: Record<string, Words> = {
  total_value_gbp: ["Portfolio value", "账户总值"], cash_gbp: ["Cash", "现金"],
  invested_gbp: ["Invested value", "投资市值"], realized_pnl_gbp: ["Realised P&L", "已实现盈亏"],
  unrealized_pnl_gbp: ["Unrealised P&L", "未实现盈亏"], opening_value_gbp: ["Opening value", "期初市值"],
  ending_value_gbp: ["Closing value", "期末市值"], net_contributions_gbp: ["Net contributions", "净流入"],
  period_pnl_gbp: ["Period net P&L", "本期净盈亏"], max_money_drawdown_gbp: ["Maximum money drawdown", "最大金额回撤"],
  carried_cfd_proxy_gbp: ["Carried CFD cash-equity proxy", "沿用的 CFD 现金权益代理值"],
  current_value_gbp: ["Position value", "持仓市值"], total_cost_gbp: ["Cost", "持仓成本"],
  unrealized_profit_loss_gbp: ["Unrealised P&L", "未实现盈亏"], fx_impact_gbp: ["FX impact", "汇率影响"],
  current_price: ["Unit price", "单位价格"], quantity: ["Quantity", "数量"], units: ["Units", "单位数"],
  value_gbp: ["Exposure", "敞口金额"], weight_fraction: ["Portfolio weight", "组合权重"],
  direct_value_gbp: ["Direct exposure", "直接敞口"], indirect_value_gbp: ["Indirect exposure", "间接敞口"],
  non_security_value_gbp: ["Non-security exposure", "非证券敞口"], invested_value_gbp: ["Invested value", "投资市值"],
  lookthrough_coverage_fraction: ["Look-through coverage", "穿透覆盖率"],
  portfolio_twr_fraction: ["Portfolio time-weighted return", "组合时间加权回报"], fraction: ["Time-weighted return", "时间加权回报"],
  return_fraction: ["Benchmark return", "基准回报"], observation_count: ["Observations", "观测数"],
  reconstructed_count: ["Reconstructed observations", "重建观测数"], shared_observation_count: ["Shared observations", "同期观测数"],
  amount_gbp: ["Amount", "金额"], effect_horizon_gbp: ["Effect at the review horizon", "复盘窗口影响"],
  effect_to_date_gbp: ["Effect to date", "至今影响"], amount: ["Amount", "金额"], gross_result: ["Gross result", "毛收益"],
  fx_fee: ["FX fee", "汇兑费用"], result_after_fx_fee: ["Result after FX fees", "扣除汇兑费用后收益"],
  date: ["Event date", "事件日期"],
};
const statusWords: Record<string, Words> = {
  ok: ["Data available", "数据可用"], partial: ["Limited coverage", "覆盖不完整"],
  unavailable: ["Data unavailable", "数据不可用"], not_applicable: ["Not applicable", "不适用"],
};
// Dataset and state identifiers published by the data_freshness tool.
const freshnessDatasets: Record<string, Words> = {
  market: ["Market data", "行情"], technical: ["Technical data", "技术指标"],
  fundamentals: ["Fundamentals", "基本面"], financials: ["Financial statements", "财务报表"],
  analyst: ["Analyst data", "分析师数据"], valuation: ["Valuation", "估值"],
  options: ["Options", "期权"], earnings: ["Earnings data", "业绩数据"],
  broker: ["Broker balances", "券商余额"], intraday_broker: ["Intraday broker balances", "盘中券商余额"],
  lookthrough: ["Look-through exposure", "穿透敞口"], cfd_cash_equity_proxy: ["CFD cash-equity proxy", "CFD 现金权益代理值"],
  invest_daily_nav: ["Invest daily NAV", "投资账户每日净值"], isa_daily_nav: ["ISA daily NAV", "ISA 每日净值"],
  cfd_daily_nav: ["CFD daily NAV", "CFD 每日净值"], intraday_nav: ["Intraday NAV", "盘中净值"],
  invest_decisions: ["Invest decisions", "投资账户交易记录"], isa_decisions: ["ISA decisions", "ISA 交易记录"],
  imported_cfd_events: ["Imported CFD events", "导入的 CFD 事件"],
};
const freshnessStates: Record<string, Words> = {
  fresh: ["Up to date", "最新"], aging: ["Ageing", "接近过期"], stale: ["Stale", "已过时"],
  missing: ["Missing", "缺失"], failed: ["Failed", "失败"], unknown: ["Unknown", "未知"],
  unsupported: ["Unsupported", "不支持"], not_applicable: ["Not applicable", "不适用"],
  ticker_status_not_published: ["Ticker status unpublished", "尚未公布此证券的数据状态"],
};
const caveats: Record<string, Words> = {
  "other-drivers": ["Other factors may also have contributed.", "其他因素也可能有影响。"],
  "attribution": ["A coincident event alone cannot establish a cause.", "仅凭事件同期发生，无法确定原因。"],
  "cash-flows": ["Cash flows can change account value independently of investment returns.", "资金进出也会改变账户市值。"],
  "concentration": ["Concentrated exposure can make portfolio moves more sensitive to a single holding.", "集中敞口可能放大单一持仓对组合的影响。"],
  "benchmark": ["Differences in portfolio composition can affect comparisons with the benchmark.", "组合成分差异可能影响基准比较。"],
  "valuation": ["The interpretation depends on the valuation assumptions.", "估值解读取决于所用假设。"],
  "history": ["Past performance alone cannot establish a trend.", "仅凭过往表现无法确定趋势。"],
  "insufficient-evidence": ["There is insufficient evidence to draw that conclusion.", "现有证据不足以支持这一结论。"],
};
export function inferenceText(key: string, locale: Locale) {
  return Object.hasOwn(caveats, key) ? word(caveats[key], locale) : null;
}

function resolveField(output: Json, pointer: string) {
  // The supported paths cover a summary, a typed subobject and a published row.
  const match = /^\/data\/(?:([a-z_]+)\/(?:(0|[1-9]\d{0,4})\/)?)?([a-z_]+)$/.exec(pointer);
  if (!match) return null;
  const [, group, index, field] = match;
  const data = object(output.data);
  const section = group && Object.hasOwn(data, group) ? data[group] : undefined;
  const parent = !group ? data : index === undefined ? object(section) : Array.isArray(section) ? object(section[Number(index)]) : {};
  if (!Object.hasOwn(parent, field)) return null;
  return { data, parent, group, field, value: parent[field] };
}
const dateText = (value: unknown) => /^\d{4}-\d{2}-\d{2}(?:T[\d:.+Z-]+)?$/.test(str(value)) ? str(value) : "";
const calendarDate = (value: unknown) => /^\d{4}-\d{2}(?:-\d{2})?$/.test(str(value)) ? str(value) : "";
const calendarStatuses: Record<string, Words> = {
  cancelled: ["cancelled", "已取消"], withdrawn: ["withdrawn", "已撤回"],
  postponed: ["postponed", "已推迟"], provisional: ["provisional", "暂定"],
};

export function calendarObservation(ref: Evidence, output: Json, pointer: string, locale: Locale, timeZone: string) {
  if (output.status !== "ok" && output.status !== "partial") return null;
  const field = resolveField(output, pointer);
  if (!field || field.group !== "items" || !["date","end_date","local_date","instant","local_time","title_en","title_zh","status"].includes(field.field)) return null;
  const row = field.parent;
  const day = calendarDate(row.date);
  const title = str(row[locale === "zh" ? "title_zh" : "title_en"]);
  if (!day || !title || !row.evidence_id) return null;
  const ticker = str(row.ticker);
  const start = row.instant && dateText(row.instant) ? formatDateTimeInTimeZone(str(row.instant), locale, timeZone) : day;
  const end = calendarDate(row.end_date);
  const when = end && end !== day ? start + " – " + end : start;
  const status = str(row.status);
  const label = Object.hasOwn(calendarStatuses,status) ? word(calendarStatuses[status],locale) : "";
  const eventTitle = label ? title + (locale === "zh" ? "（" + label + "）" : " (" + label + ")") : title;
  const args: Record<string,string> = {snapshotId:str(output.snapshot_id),eventId:str(row.evidence_id),date:str(row.local_date) || day};
  let source: Evidence["source"] = "calendar";
  if (row.kind === "earnings" || row.kind === "ex_dividend") {
    source = row.kind === "earnings" ? "financials" : "disclosure";
    args.holdingTicker = ticker;
    args.event = row.kind === "ex_dividend" ? "exDividend" : row.research_event_id ? "earnings" : "earningsWindow";
    if (row.research_event_id) args.researchEventId = str(row.research_event_id);
    if (row.end_date) args.endDate = str(row.end_date);
  } else if (row.source_url) args.url = str(row.source_url);
  const limited = output.status === "partial" ? word(["limited coverage","覆盖不完整"], locale) : "";
  return {text:[ticker || str(row.market),eventTitle,when,limited].filter(Boolean).join(" · "), evidence:{...ref, source, arguments:args}};
}

function money(value: number, unit: unknown, digits = 2) {
  if (unit === "GBp" || unit === "GBX" || unit === "GBx") return number(value, digits) + " GBp";
  return /^[A-Z]{3}$/.test(str(unit)) ? currency(value, str(unit), digits) : null;
}
function researchField(row: NonNullable<ReturnType<typeof resolveField>>, locale: Locale) {
  const {parent, value, data} = row;
  const path = str(parent.path);
  if (path === "/as_of" && dateText(value)) return [word(["As of", "截至"], locale), dateText(value)];
  const names: Record<string, Words> = {"/sector": ["Sector", "板块"], "/industry": ["Industry", "行业"], "/country": ["Country", "国家"]};
  if (Object.hasOwn(names, path) && typeof value === "string" && value.length <= 80) return [word(names[path], locale), value];
  const n = numeric(value);
  if (n === null) return null;
  if (path === "/technical_score") return [word(["Technical score", "技术评分"], locale), number(n)];
  if (path === "/expiry_count" && Number.isSafeInteger(n) && n >= 0) return [word(["Expiries", "到期日数"], locale), number(n, 0)];
  if (path === "/spot" || path === "/price") {
    const quote = objects(data.items).find(item => item.dataset === parent.dataset && item.path === "/currency");
    const price = money(n, quote?.value, 4);
    if (price) return [word(["Price", "价格"], locale), price];
  }
  return null;
}
function formatField(tool: string, row: NonNullable<ReturnType<typeof resolveField>>, locale: Locale) {
  const { field, parent, group, value } = row;
  if (tool === "read_research_lens" && field === "value") return researchField(row, locale);
  if (field === "date" && dateText(value)) return [word(labels.date, locale), dateText(value)];
  if (tool === "data_freshness" && group === "items" && field === "state") {
    const dataset = str(parent.dataset);
    const state = str(value);
    if (!Object.hasOwn(freshnessDatasets, dataset) || !Object.hasOwn(freshnessStates, state)) return null;
    return [word(freshnessDatasets[dataset], locale), word(freshnessStates[state], locale)];
  }
  const n = numeric(value);
  if (n === null) return null;
  if (tool === "read_valuation_evidence" && field === "value" && parent.state === "available" && str(parent.metric)) {
    const unit = parent.unit;
    let display: string | null = null;
    if (unit === "currency" || unit === "perShare") {
      display = money(n, parent.currency, unit === "perShare" ? 4 : 2);
      if (display && unit === "perShare") display += word(["/share", "/股"], locale);
    } else if (unit === "ratio") display = percent(n, false, 2);
    else if (unit === "shares") display = number(n, 4) + (word([" shares", " 股"], locale));
    else if (unit === "multiple") display = number(n, 3) + "×";
    return display ? [str(parent.metric), display] : null;
  }
  if (!Object.hasOwn(labels, field)) return null;
  let display: string | null = null;
  if (field.endsWith("_gbp")) display = currency(n, "GBP", 2);
  else if (field.endsWith("_fraction") || (tool === "period_performance" && group === "twr" && field === "fraction")) display = percent(n, false, 2);
  else if (field === "current_price") display = money(n, parent.price_currency, 4);
  else if (field.endsWith("_count") && Number.isSafeInteger(n) && n >= 0) display = number(n, 0);
  else if (field === "quantity" || field === "units") display = number(n, 6);
  else if (tool === "recent_decisions") display = money(n, parent.currency);
  return display ? [word(labels[field], locale), display] : null;
}

/** Every displayed word of a factual line comes from trusted copy or the cited output. */
export function renderToolField(tool: string, output: Json, pointer: string, locale: Locale, timeZone: string, research?: ResearchFigure | null) {
  const status = str(output.status);
  if (!Object.hasOwn(statusWords, status)) return null;
  const data = object(output.data);
  const coverage = str(data.coverage);
  const issues = object(output.quality).issues;
  const limited = status === "partial" || (Array.isArray(issues) && issues.length > 0) || (!!coverage && coverage !== "complete");
  const limitedText = word(["limited coverage", "覆盖不完整"], locale);
  if (pointer === "/status") return status === "ok" && limited ? limitedText : word(statusWords[status], locale);
  if (status !== "ok" && status !== "partial") return null;
  if (pointer === "/data/coverage" && coverage) return limited ? limitedText : word(["Complete coverage", "覆盖完整"], locale);
  if (research !== undefined) return research ? [research.text, limited ? limitedText : ""].filter(Boolean).join(" · ") : null;
  const row = resolveField(output, pointer);
  if (!row || (row.group === "twr" && row.parent.status !== "ok")) return null;
  const formatted = formatField(tool, row, locale);
  if (!formatted) return null;
  const {parent, field} = row;
  const date = dateText(parent.observed_at) || dateText(parent.as_of) || dateText(parent.date)
    || dateText(field.includes("pnl") ? parent.pnl_as_of : parent.values_as_of) || dateText(data.broker_as_of);
  const start = dateText(object(parent.period).start) || dateText(parent.start) || dateText(data.window_start) || dateText(data.start);
  const end = dateText(object(parent.period).end) || dateText(parent.end) || dateText(data.window_end) || dateText(data.end);
  // A freshness result can cite several datasets. Only this row dates its state.
  const freshness = tool === "data_freshness";
  const sourceDates = freshness ? [] : objects(output.sources).map(source => dateText(source.as_of)).filter(Boolean);
  const localDate = (value: string) => value.includes("T") ? formatDateTime(value, locale, timeZone) : value;
  const period = start && end ? localDate(start) + " – " + localDate(end) : localDate(end || date) || [...new Set(sourceDates)].map(localDate).join(" / ");
  const accounts: Record<string, Words> = {invest:["Invest", "投资账户"], isa:["ISA", "ISA"], cfd:["CFD", "CFD"],
    broker_total:["All investment accounts", "全部投资账户"], household:["Household", "家庭账户"]};
  const scope = str(parent.scope) || str(output.scope);
  const subject = [str(parent.ticker) || str(parent.name) || str(data.ticker) || (freshness ? "" : str(parent.dataset)), Object.hasOwn(accounts, scope) ? word(accounts[scope], locale) : ""]
    .filter(Boolean).join(" · ");
  return [subject, formatted.join(freshness ? " · " : " "), period === formatted[1] ? "" : period, limited || parent.status === "partial" ? limitedText : ""].filter(Boolean).join(" · ");
}
