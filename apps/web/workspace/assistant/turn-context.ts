import type { UIMessage } from "ai";
import type { Locale } from "@/components/locale-provider";
import { object, str } from "../data";
import { countryName, industryName } from "../exposure-names";
import type { PageTurnContext, RoleCard, TurnObservation } from "./context";
import { chatContext, readableDates } from "./evidence";

type Words = readonly [zh: string, en: string];

export type TurnContextObject = {
  start?: string;
  end?: string;
  date?: string;
  decision_date?: string;
  horizon?: string;
  habit?: string;
  ticker?: string;
  dimension?: string;
  category?: string;
  group?: string;
  market?: string;
  sector?: string;
  issue?: string;
};

export type TurnContext = {
  page?: string;
  role?: string;
  scope?: string;
  range?: string;
  ticker?: string;
  lens?: string;
  benchmark?: string;
  start?: string;
  end?: string;
  indexId?: string;
  market?: string;
  horizon?: string;
  habit?: string;
  snapshotId?: string;
  object?: TurnContextObject;
  observation?: TurnObservation;
};

export type ResolvedTurn = {
  requestContext: Record<string, unknown>;
  turnContext: TurnContext;
  card: RoleCard | null;
};

const OBJECT_KEYS = [
  "start",
  "end",
  "date",
  "decision_date",
  "horizon",
  "habit",
  "ticker",
  "dimension",
  "category",
  "group",
  "market",
  "sector",
  "issue",
] as const;

const PAGE_LABELS: Record<string, Words> = {
  overview: ["组合总览", "Overview"],
  holdings: ["持仓与穿透", "Holdings"],
  analytics: ["收益与风险", "Performance"],
  sectors: ["市场", "Markets"],
  research: ["研究", "Research"],
  review: ["投资复盘", "Review"],
  health: ["数据状态", "Data status"],
  settings: ["设置", "Settings"],
};

const LENS_LABELS: Record<string, Words> = {
  overview: ["概览", "Overview"],
  fundamentals: ["财务", "Financials"],
  technical: ["价格", "Price"],
  analyst: ["预期", "Estimates"],
  valuation: ["估值", "Valuation"],
  options: ["期权", "Options"],
  ledger: ["记录", "Journal"],
  tracking: ["跟踪", "Tracking"],
  peers: ["同类", "Peers"],
  constituents: ["成分", "Members"],
};

const ROLE_LABELS: Record<string, Words> = {
  daily: ["日报", "Daily brief"],
  weekly: ["周报", "Weekly brief"],
  habits: ["习惯", "Habits"],
  decision: ["复盘", "Review"],
  exposure: ["敞口", "Exposure"],
  attribution: ["归因", "Attribution"],
  "market-sector": ["盘面", "Market moves"],
  "market-map": ["盘面", "Market moves"],
  diagnosis: ["排障", "Diagnosis"],
  "your-position": ["与我相关", "Your position"],
  "key-moment": ["关键时刻", "Key moments"],
  "earnings-brief": ["财报速读", "Earnings brief"],
  "company-summary": ["中文摘要", "Chinese summary"],
};

const SCOPE_LABELS: Record<string, Words> = {
  broker_total: ["全部投资账户", "All investment accounts"],
  invest: ["投资账户", "Invest"],
  isa: ["ISA", "ISA"],
  cfd: ["CFD", "CFD"],
  household: ["家庭账户", "Household"],
};

const HORIZON_LABELS: Record<string, Words> = {
  "20_sessions": ["20 个交易日", "20 trading days"],
  to_date: ["至今", "To date"],
};

const HABIT_LABELS: Record<string, Words> = {
  before_earnings: ["财报前买入", "Pre-earnings buys"],
  basket_buy: ["同日多只买入", "Same-day basket buys"],
  untraded_fall: ["大跌未加仓", "Untraded falls"],
};

const MARKET_LABELS: Record<string, Words> = {
  global: ["全球", "Global"],
  us: ["美股", "US"],
  uk: ["英股", "UK"],
  eu: ["欧洲", "Europe"],
  europe: ["欧洲", "Europe"],
  jp: ["日本", "Japan"],
  hk: ["香港", "Hong Kong"],
  kr: ["韩国", "South Korea"],
  cn: ["中国", "China"],
  tw: ["台湾", "Taiwan"],
  in: ["印度", "India"],
  ca: ["加拿大", "Canada"],
  au: ["澳大利亚", "Australia"],
  ch: ["瑞士", "Switzerland"],
};

const OBSERVATION_LABELS: Record<string, Words> = {
  earnings: ["财报", "Earnings"],
  research_earnings: ["财报", "Earnings"],
  ex_dividend: ["除息日", "Ex-dividend date"],
  dividend_pay: ["派息日", "Dividend payment"],
  dividend: ["股息", "Dividend"],
  rating_change: ["评级变动", "Rating change"],
  filing: ["披露", "Filing"],
  macro: ["官方发布", "Official release"],
  decision: ["交易决定", "Trade decision"],
};
const CITED_OBSERVATION: Words = ["引用记录", "Cited observation"];

const OTHER_EXPOSURE: Words = ["其他", "Other"];
const UNRESOLVED_EXPOSURE: Words = ["未穿透", "Unresolved"];
const ALL_PERIOD: Words = ["全部", "All"];
const DIAGNOSIS_LABELS: Record<string, Words> = {
  job: ["更新任务", "Update job"],
  stale: ["数据过期", "Stale data"],
};

const VALID_RANGES = new Set(["1D", "5D", "1W", "1M", "3M", "6M", "YTD", "1Y", "2Y", "3Y", "5Y", "ALL", "MAX"]);
const VALID_BENCHMARKS = new Set(["VOO", "QQQ", "VT", "ALL"]);

function pick(words: Words, locale: Locale): string {
  return locale === "en" ? words[1] : words[0];
}

function sanitizeObject(raw: unknown): TurnContextObject | undefined {
  const source = object(raw);
  const result: TurnContextObject = {};
  let hasField = false;
  for (const key of OBJECT_KEYS) {
    const value = str(source[key]).trim();
    if (value && value.length <= 180) {
      result[key] = value;
      hasField = true;
    }
  }
  return hasField ? result : undefined;
}

function normalizeTurnContext(raw: unknown): TurnContext | null {
  const source = object(raw);
  const ctx: TurnContext = {};
  const page = str(source.page);
  if (Object.hasOwn(PAGE_LABELS, page)) ctx.page = page;
  const role = str(source.role);
  if (Object.hasOwn(ROLE_LABELS, role)) ctx.role = role;
  const scope = str(source.scope);
  if (Object.hasOwn(SCOPE_LABELS, scope)) ctx.scope = scope;
  const range = str(source.range);
  if (VALID_RANGES.has(range)) ctx.range = range;
  const ticker = str(source.ticker);
  if (ticker && /^[A-Z0-9^=._-]{1,32}$/i.test(ticker)) ctx.ticker = ticker.toUpperCase();
  const lens = str(source.lens);
  if (Object.hasOwn(LENS_LABELS, lens)) ctx.lens = lens;
  const benchmark = str(source.benchmark);
  if (VALID_BENCHMARKS.has(benchmark)) ctx.benchmark = benchmark;
  const indexId = str(source.indexId);
  if (/^[a-z0-9-]{1,64}$/.test(indexId)) ctx.indexId = indexId;
  for (const field of ["start", "end"] as const) {
    const date = str(source[field]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) ctx[field] = date;
  }
  const market = str(source.market);
  if (Object.hasOwn(MARKET_LABELS, market)) ctx.market = market;
  const horizon = str(source.horizon);
  if (Object.hasOwn(HORIZON_LABELS, horizon)) ctx.horizon = horizon;
  const habit = str(source.habit);
  if (Object.hasOwn(HABIT_LABELS, habit)) ctx.habit = habit;
  const snapshotId = str(source.snapshotId);
  if (snapshotId && /^[A-Za-z0-9_-]{1,100}$/.test(snapshotId)) ctx.snapshotId = snapshotId;
  const selected = sanitizeObject(source.object);
  if (selected) ctx.object = selected;
  const observation = object(source.observation);
  const kind = str(observation.kind);
  if (kind) {
    ctx.observation = {
      kind,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(observation.date)) ? str(observation.date) : undefined,
      end: /^\d{4}-\d{2}-\d{2}$/.test(str(observation.end)) ? str(observation.end) : undefined,
      instant: /^\d{4}-\d{2}-\d{2}T/.test(str(observation.instant)) ? str(observation.instant) : undefined,
    };
  }
  const hasVisibleContext = Boolean(
    ctx.page || ctx.role || ctx.scope || ctx.range || ctx.ticker || ctx.lens || ctx.benchmark || ctx.object,
  );
  return hasVisibleContext ? ctx : null;
}

/** Resolve the exact payload sent to /assistant/chat and the matching per-turn context metadata. */
export function resolveTurnTarget(
  card: RoleCard | null,
  page: string,
  search: string,
  timeZone: string,
  selection?: PageTurnContext | null,
): ResolvedTurn {
  const boundCard = card?.role ? card : null;
  const origin = boundCard?.origin ?? { page, search, snapshotId: boundCard?.reading?.snapshotId ?? undefined };
  const base = chatContext(origin.page, boundCard ? origin.search : "", timeZone,
    boundCard ? undefined : selection, boundCard ? origin.research : undefined);
  const selected = boundCard?.context ?? {};
  const selectedScope = str(selected.scope);
  const requestContext = boundCard ? {
    ...base,
    ...(Object.hasOwn(SCOPE_LABELS, selectedScope) ? { scope: selectedScope } : {}),
    role: boundCard.role,
    object: selected,
    ...(origin.snapshotId ? { snapshotId: origin.snapshotId } : {}),
  } : base;
  return {
    requestContext,
    turnContext: normalizeTurnContext(requestContext) ?? {},
    card: boundCard ? { ...boundCard, origin } : null,
  };
}

/** Read structured per-turn context from UIMessage.metadata; returns null for older turns without one. */
export function extractTurnContext(message: UIMessage): TurnContext | null {
  const metadata = object(message.metadata);
  if (!("turnContext" in metadata)) return null;
  return normalizeTurnContext(metadata.turnContext);
}

/** Produce a compact, localized context pill label using existing workspace terms. */
export function formatTurnContext(
  ctx: TurnContext,
  locale: Locale,
  timeZone: string,
  now: Date | number = Date.now(),
): string {
  const parts: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
  };

  const instrument = (ctx.ticker === "INDEX" ? ctx.indexId : ctx.ticker) ?? ctx.indexId ?? ctx.object?.ticker;
  if (ctx.role && Object.hasOwn(ROLE_LABELS, ctx.role)) {
    push(pick(ROLE_LABELS[ctx.role], locale));
  } else if (ctx.page === "research" && ctx.lens && Object.hasOwn(LENS_LABELS, ctx.lens)) {
    if (instrument) {
      push(instrument);
      push(pick(LENS_LABELS[ctx.lens], locale));
    } else {
      push(pick(PAGE_LABELS.research, locale));
      push(pick(LENS_LABELS[ctx.lens], locale));
    }
  } else if (ctx.page && Object.hasOwn(PAGE_LABELS, ctx.page)) {
    push(pick(PAGE_LABELS[ctx.page], locale));
  }

  if (instrument) push(instrument);

  const selected = ctx.object;
  if (ctx.market) push(pick(MARKET_LABELS[ctx.market], locale));
  if (ctx.role === "exposure" && selected?.category) {
    if (selected.group === "tail" || selected.category === "tail") push(pick(OTHER_EXPOSURE, locale));
    else if (selected.group === "unresolved" || selected.category === "unresolved") push(pick(UNRESOLVED_EXPOSURE, locale));
    else if (selected.dimension === "country") push(countryName(selected.category, locale) ?? selected.category);
    else if (selected.dimension === "sector" || selected.dimension === "gics") push(industryName(selected.category, locale));
    else push(selected.category);
  } else if (ctx.role === "market-sector" && selected?.sector) {
    push(industryName(selected.sector, locale));
  } else if (ctx.role === "market-map" && selected?.market) {
    const market = selected.market.toLowerCase();
    if (Object.hasOwn(MARKET_LABELS, market)) push(pick(MARKET_LABELS[market], locale));
  } else if (selected?.habit || ctx.habit) {
    const habit = selected?.habit ?? ctx.habit!;
    if (Object.hasOwn(HABIT_LABELS, habit)) push(pick(HABIT_LABELS[habit], locale));
  } else if (selected?.issue && Object.hasOwn(DIAGNOSIS_LABELS, selected.issue)) {
    push(pick(DIAGNOSIS_LABELS[selected.issue], locale));
  }

  if (ctx.scope && Object.hasOwn(SCOPE_LABELS, ctx.scope)) {
    push(pick(SCOPE_LABELS[ctx.scope], locale));
  }

  if (ctx.observation) {
    const kind = ctx.observation.kind;
    push(pick(Object.hasOwn(OBSERVATION_LABELS, kind) ? OBSERVATION_LABELS[kind] : CITED_OBSERVATION, locale));
  }
  const date = selected?.date ?? selected?.decision_date ?? ctx.observation?.instant
    ?? (ctx.observation?.end ? undefined : ctx.observation?.date);
  const start = selected?.start ?? ctx.start ?? ctx.observation?.date;
  const end = selected?.end ?? ctx.end ?? ctx.observation?.end;
  const horizon = selected?.horizon ?? ctx.horizon;
  if (date) {
    push(readableDates(date, locale, timeZone, now));
  } else if (start && end) {
    const span = start === end ? start : `${start} – ${end}`;
    push(readableDates(span, locale, timeZone, now));
  } else if (ctx.range) {
    push(["ALL", "MAX"].includes(ctx.range) ? pick(ALL_PERIOD, locale) : ctx.range);
  } else if (horizon && Object.hasOwn(HORIZON_LABELS, horizon)) {
    push(pick(HORIZON_LABELS[horizon], locale));
  }

  if (ctx.benchmark) push(ctx.benchmark);

  return parts.join(" · ");
}
