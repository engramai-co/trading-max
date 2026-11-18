import type { ResearchShell } from "@/lib/types";

export type SearchPage = { href: string; label: string; aliases: string };
export type SearchResult = {
  href: string;
  label: string;
  detail?: string;
  group: "recent" | "pages" | "research" | "indices";
};
/** An index from the catalogue; those in the research list sit with its stocks and funds. */
export type SearchIndex = { id: string; label: string; detail?: string; aliases: string; listed: boolean };
type Instrument = Pick<ResearchShell["instruments"][number], "ticker" | "name">;
type Locale = "zh" | "en";
const normalise = (value: string) => value.normalize("NFKC").trim().toLowerCase();
const matches = (value: string, query: string) => {
  const text = normalise(value);
  return query.split(/\s+/).every((word) => text.includes(word));
};

export const pageAliases: Record<string, string> = Object.fromEntries(Object.entries({
  "/": ["组合", "总览", "overview", "portfolio", "home"],
  "/holdings": ["持仓", "穿透", "配置", "holdings", "positions", "allocation", "look-through"],
  "/analytics": ["收益", "绩效", "performance", "analytics", "returns"],
  "/sectors": ["市场", "板块", "行业", "行情", "主题", "markets", "sectors", "industries", "themes"],
  // "ETF" stays with ETF look-through; funds are found here by name.
  "/research": ["研究", "研究清单", "股票", "个股", "基金", "指数", "证券", "research", "research list", "watchlist", "stocks", "funds", "index", "indices"],
  "/review": ["投资", "复盘", "交易", "review", "history", "trades"],
  "/health": ["数据", "状态", "同步", "活动", "health", "data status", "sync", "activity"],
  "/settings": ["设置", "连接", "settings", "connections", "integrations"],
}).map(([href, aliases]) => [href, aliases.join(" ")]));

const lenses = [
  { view: "overview", zh: "概览", en: "Overview", aliases: ["overview", "概览", "总览"] },
  { view: "technical", zh: "价格与技术", en: "Price & technicals", aliases: ["technicals", "technical", "技术面", "技术", "k线"] },
  { view: "fundamentals", zh: "财务与业务", en: "Financials & business", aliases: ["fundamentals", "financials", "财务报表", "基本面", "财务", "报表"] },
  { view: "analyst", zh: "预期与事件", en: "Estimates & events", aliases: ["analyst", "estimates", "分析师", "预期", "事件"] },
  { view: "valuation", zh: "估值", en: "Valuation", aliases: ["valuation", "dcf", "估值模型", "估值"] },
  { view: "options", zh: "期权结构", en: "Options", aliases: ["options", "option chain", "期权链", "期权"] },
  { view: "ledger", zh: "研究记录", en: "Journal", aliases: ["journal", "ledger", "研究记录"] },
] as const;

const indexViews = [
  { view: "overview", zh: "概览", en: "Overview" },
  { view: "price", zh: "价格与走势", en: "Price & trend" },
  { view: "constituents", zh: "成分与权重", en: "Constituents & weights" },
  { view: "tracking", zh: "跟踪产品", en: "Tracking products" },
] as const;

function lensQuery(query: string) {
  for (const lens of lenses) {
    for (const alias of lens.aliases) {
      if (query === alias) return { lens, security: "" };
      if (query.endsWith(" " + alias)) return { lens, security: query.slice(0, -alias.length).trim() };
      if (query.startsWith(alias + " ")) return { lens, security: query.slice(alias.length).trim() };
      if (/[^\x00-\x7f]/.test(alias) && query.endsWith(alias)) {
        return { lens, security: query.slice(0, -alias.length).trim() };
      }
    }
  }
  return null;
}

function researchHref(ticker: string, view = "overview") {
  const params = new URLSearchParams({ ticker });
  if (view !== "overview") params.set("view", view);
  return "/research?" + params.toString();
}

function indexResearchHref(id: string, view = "overview") {
  return "/research?type=index&index=" + id + (view !== "overview" ? "&view=" + view : "");
}

export function searchWorkspace({ query, pages, instruments, indices = [], recent, currentTicker, locale }: {
  query: string;
  pages: SearchPage[];
  instruments: readonly Instrument[];
  indices?: readonly SearchIndex[];
  recent: readonly SearchResult[];
  currentTicker?: string | null;
  locale: Locale;
}): SearchResult[] {
  const match = normalise(query);
  const views: SearchPage[] = [
    { href: "/holdings?view=lookthrough", label: locale === "zh" ? "ETF 穿透" : "ETF look-through", aliases: ["穿透", "etf", "lookthrough", "look-through", "exposure"].join(" ") },
    { href: "/analytics?view=returns", label: locale === "zh" ? "收益对比 · TWR" : "Return comparison · TWR", aliases: ["twr", "收益对比", "回报对比", "return comparison", "benchmark"].join(" ") },
    { href: "/analytics?view=risk", label: locale === "zh" ? "风险分析" : "Risk analysis", aliases: ["风险", "risk", "drawdown", "回撤"].join(" ") },
  ];
  const foundPages = [...pages, ...views]
    .filter((page) => !match || matches(page.label + " " + page.aliases + " " + page.href, match))
    .map((page): SearchResult => ({ href: page.href, label: page.label, group: "pages" }));
  const target = lensQuery(match);
  // A bare lens only applies to the explicit current security. Never pick the
  // first directory entry or add/refresh a security on the user's behalf.
  const security = target?.security || (target && currentTicker ? normalise(currentTicker) : match);
  const foundInstruments = (target && !target.security && !currentTicker ? [] : instruments)
    .filter((item) => !security || matches(item.ticker + " " + item.name, security))
    .slice().sort((a, b) => Number(normalise(b.ticker) === security) - Number(normalise(a.ticker) === security))
    .slice(0, 8)
    .map((item): SearchResult => ({
      href: researchHref(item.ticker, target?.lens.view),
      label: item.ticker + (target ? " · " + target.lens[locale] : ""),
      detail: item.name,
      group: "research",
    }));
  // Lens shortcuts such as "ARM 技术面" apply to stocks and funds only.
  const matchingIndices = target ? [] : indices
    .filter((item) => !match || matches(item.label + " " + (item.detail ?? "") + " " + item.aliases, match));
  const indexResult = (item: SearchIndex): SearchResult => ({
    href: indexResearchHref(item.id),
    label: item.label,
    detail: item.detail,
    group: item.listed ? "research" : "indices",
  });
  const listedIndices = matchingIndices.filter((item) => item.listed).map(indexResult);
  const otherIndices = match ? matchingIndices.filter((item) => !item.listed).slice(0, 5).map(indexResult) : [];
  // Without a query the list previews its first eight entries, stocks and funds first.
  const research = [...foundInstruments, ...listedIndices].slice(0, match ? undefined : 8);
  const foundRecent = match ? [] : recent;
  const seen = new Set<string>();
  const exactTicker = instruments.some((item) => normalise(item.ticker) === match);
  const found = exactTicker ? [...research, ...foundPages] : [...foundPages, ...research];
  return [...foundRecent, ...found, ...otherIndices].filter((item) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

export function needsSecurity(query: string, currentTicker?: string | null) {
  const target = lensQuery(normalise(query));
  return Boolean(target && !target.security && !currentTicker);
}

// Allowlisted navigation only: no search text, balances, tokens, or arbitrary
// query parameters are retained. Recent visits live in the mounted shell only.
export function recentVisit(
  pathname: string,
  params: URLSearchParams,
  pages: SearchPage[],
  locale: Locale,
  indexName?: (id: string) => string | undefined,
): SearchResult | null {
  const page = pages.find((item) => item.href === pathname);
  if (!page) return null;
  let href = pathname;
  let label = page.label;
  const view = params.get("view");
  if (pathname === "/research" && params.get("type") === "index") {
    const id = params.get("index");
    if (!id || !/^[a-z0-9-]{1,60}$/.test(id)) return null;
    const lens = indexViews.find((item) => item.view === view) ?? indexViews[0];
    href = indexResearchHref(id, lens.view);
    label = (indexName?.(id) ?? id) + " · " + lens[locale];
  } else if (pathname === "/research") {
    const ticker = params.get("ticker");
    if (!ticker || !/^[\w.^=-]{1,40}$/.test(ticker)) return null;
    const lens = lenses.find((item) => item.view === view) ?? lenses[0];
    href = researchHref(ticker, lens.view);
    label = ticker + " · " + lens[locale];
  } else if (pathname === "/holdings" && view === "lookthrough") {
    href += "?view=lookthrough";
    label = locale === "zh" ? "ETF 穿透" : "ETF look-through";
  } else if (pathname === "/analytics" && (view === "returns" || view === "risk")) {
    href += "?view=" + view;
    label = view === "returns" ? (locale === "zh" ? "收益对比 · TWR" : "Return comparison · TWR") : (locale === "zh" ? "风险分析" : "Risk analysis");
  }
  return { href, label, group: "recent" };
}

export function rememberVisit(recent: readonly SearchResult[], visit: SearchResult): SearchResult[] {
  return [visit, ...recent.filter((item) => item.href !== visit.href)].slice(0, 6);
}

export function highlightParts(text: string, query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return [{ text, match: false }];
  const pattern = new RegExp("(" + words.sort((a, b) => b.length - a.length).join("|") + ")", "gi");
  return text.split(pattern).filter(Boolean).map((part) => ({ text: part, match: words.some((word) => new RegExp("^(?:" + word + ")$", "i").test(part)) }));
}
