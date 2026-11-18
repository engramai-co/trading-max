import { citedEventKind } from "@/lib/cited-calendar-event";
import type { components } from "@/lib/api-schema";
import { formatDateTimeInTimeZone } from "@/ui/formatters";
import type { UIMessage } from "ai";
import { object, safeUrl, str, type Json } from "../data";

export const sourceWords = {
  account: ["账户", "Account"], broker: ["券商", "Broker"], holdings: ["持仓", "Holdings"],
  exposure: ["穿透", "Exposure"], market: ["行情", "Market"], technical: ["技术", "Technicals"],
  financials: ["财报", "Financials"], analysts: ["分析师", "Analysts"], disclosure: ["披露", "Disclosure"],
  review: ["复盘", "Review"], health: ["数据状态", "Data status"], calendar: ["日历", "Calendar"],
  inference: ["推断", "Inference"], publisher: ["披露", "Disclosure"],
} as const;
export type Evidence = components["schemas"]["ReadingEvidence"];
export type Reading = components["schemas"]["RoleReading"];

export function sourceLabel(evidence: Evidence | null, t: (zh: string, en: string) => string) {
  if (evidence?.source === "publisher" && evidence.publisher) return evidence.publisher;
  const [zh, en] = sourceWords[evidence?.source ?? "inference"];
  return t(zh, en);
}

const destinations: Record<string, [string, Evidence["source"]]> = {
  portfolio_overview: ["/", "account"], period_performance: ["/analytics", "account"], compare_benchmarks: ["/analytics", "market"],
  list_holdings: ["/holdings", "holdings"], position_detail: ["/holdings", "holdings"], lookthrough_exposure: ["/holdings", "exposure"],
  read_research_lens: ["/research", "market"], read_valuation_evidence: ["/research", "financials"], recent_decisions: ["/review", "review"],
  research_position: ["/research", "market"], price_key_moments: ["/research", "technical"],
  research_earnings: ["/research", "financials"], research_headline: ["/research", "publisher"],
  selected_exposure: ["/holdings","exposure"], selected_daily: ["/analytics","account"],
  selected_fx: ["/analytics","holdings"], sector_headline: ["/sectors","publisher"],
  selected_money: ["/analytics","account"], daily_returns: ["/analytics", "account"], holding_fx_split: ["/analytics","holdings"],
  dated_exposure: ["/holdings","exposure"], exposure_benchmark: ["/holdings","exposure"],
  market_sector: ["/sectors","market"], global_map: ["/sectors","market"], update_issue: ["/health","health"],
  news_and_events: ["/research","disclosure"], data_freshness: ["/health", "health"],
  upcoming_events: ["/health", "calendar"],
  decision_timing_and_habits: ["/review", "review"], review_patterns: ["/review", "review"],
};
const lensWords: Record<string, Evidence["source"]> = { technical: "technical", fundamentals: "financials", analyst: "analysts", ledger: "disclosure" };
export function evidenceHref(ref: Evidence): string | null {
  if (!ref.arguments?.rowCitation && ref.tool === "news_and_events" && ref.arguments?.event === "own_trade") {
    const args = ref.arguments;
    if (!args.snapshotId || !args.eventId || !["invest", "isa"].includes(args.scope) ||
        !["buy", "sell"].includes(args.side) || !args.date || !args.ticker) return null;
    const query = new URLSearchParams({
      account:args.scope === "invest" ? "A" : "B",
      decision:[args.date, args.side, args.ticker].join("."), snapshotId:args.snapshotId,
    });
    return "/review?" + query;
  }
  if (!ref.arguments?.rowCitation && (ref.tool === "upcoming_events" || (ref.tool === "news_and_events" && ref.arguments?.eventId && ref.arguments.snapshotId))) {
    const args = ref.arguments ?? {};
    if (args.url) return safeUrl(args.url) ?? null;
    if (args.holdingTicker && args.eventId) {
      return evidenceHref({...ref, tool:"read_research_lens", arguments:{
        ticker:args.holdingTicker, lens:args.researchEventId ? "analyst" : "overview", event:args.event,
        date:args.date, end:args.endDate, eventId:args.researchEventId,
        snapshotId:args.snapshotId, calendarEventId:args.eventId,
      }});
    }
    return null;
  }
  const entry = destinations[ref.tool];
  if (!entry) return null;
  const a = ref.arguments ?? {};
  const decisionEvent = ref.tool === "decision_timing_and_habits" && a.lens === "analyst" && Boolean(a.listing);
  // A cited calendar or account row reopens from its research publication.
  const path = decisionEvent || a.rowCitation ? "/research" : entry[0];
  const params = new URLSearchParams();
  if (a.snapshotId && ["/holdings","/sectors"].includes(path)) params.set("snapshotId",a.snapshotId);
  if (ref.source === "inference") return null;
  // A saved research headline reopens its publication, which links the original article.
  if (ref.source === "publisher" && a.url && !(ref.tool === "research_headline" && a.snapshotId)) {
    try {const url = new URL(a.url); return ["https:","http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;} catch {return null;}
  }
  const eventSource = decisionEvent || ref.tool === "news_and_events";
  if (eventSource && !a.rowCitation && a.url && /^https:\/\//i.test(a.url)) {
    try { const url = new URL(a.url); if (!url.username && !url.password) return url.href; } catch {}
  }
  if (path === "/review") {
    if (a.snapshotId) params.set("snapshotId", a.snapshotId);
    if (a.scope === "invest" || a.scope === "isa") params.set("account", a.scope === "invest" ? "A" : "B");
    if (a.ticker && a.side && a.decision_date) params.set("decision",[a.decision_date,a.side,a.ticker].join("."));
    if (a.ordinal && /^\d+$/.test(a.ordinal)) params.set("reviewOrdinal",a.ordinal);
    const horizon = a.comparedHorizon || a.horizon;
    if (horizon === "20_sessions" || horizon === "to_date") params.set("reviewWindow", horizon);
    const habit = a.habit || a.habitSection;
    if (habit) params.set("habit", habit);
  }
  if (path === "/analytics") {
    params.set("view", ref.tool === "period_performance" && (a.metric === "period_pnl_gbp" || a.range === "1D") ? "money" : "returns");
    if (["daily_returns","selected_money","holding_fx_split","selected_daily","selected_fx"].includes(ref.tool) && a.start && a.end) {
      params.set("view",a.view ?? "returns"); params.set("inspectFrom",a.start); params.set("inspectTo",a.end);
      if (a.snapshotId) params.set("snapshotId",a.snapshotId);
    }
    if (a.range) params.set("range", a.range);
    if (a.metric === "period_pnl_gbp" && a.start && a.end && a.snapshotId) {
      params.set("moneyFrom", a.start);
      params.set("moneyTo", a.end);
      params.set("snapshotId", a.snapshotId);
    }
    if (a.benchmark) params.set("benchmark", a.benchmark);
    if (ref.tool === "compare_benchmarks") {
      if (!a.snapshotId) return null;
      params.set("snapshotId", a.snapshotId);
    }
    if (ref.tool === "compare_benchmarks" && a.start && a.end && a.start.length === 10 && a.end.length === 10) {
      params.set("returnFrom", a.start);
      params.set("returnTo", a.end);
    }
  }
  if (a.scope && a.scope !== "broker_total") {
    if (path === "/holdings" && ["invest", "isa"].includes(a.scope)) params.set("account", a.scope === "invest" ? "A" : "B");
    else if (path !== "/holdings" && path !== "/review") params.set("scope", a.scope);
  }
  if (["lookthrough_exposure","dated_exposure","exposure_benchmark","selected_exposure"].includes(ref.tool)) {
    params.set("view","lookthrough");
    if (a.dimension) params.set("dimension",a.dimension);
    if (a.category) params.set("category",a.category);
    if (a.group) params.set("group", a.group);
    if (a.entityId) params.set("entityId", a.entityId);
    if (ref.tool === "exposure_benchmark") {
      for (const field of ["benchmarkSource","benchmarkAsOf","benchmarkObservation"]) {
        if (a[field]) params.set(field,a[field]);
      }
    }
  }
  if (path === "/sectors") {
    params.set("market",ref.tool==="global_map" ? "global" : a.market ?? "global");
    if (a.sector) {params.set("sector",a.sector); if(a.market === "global") params.set("view","sectors");}
    if (ref.tool === "global_map" && a.market) params.set("region",a.market);
    if (a.observed) params.set("observed",a.observed);
    if (a.grouping) params.set("grouping",a.grouping);
  }
  if (ref.tool === "update_issue" && a.job) params.set("job",a.job);
  if (a.ticker && path === "/holdings") params.set("q", a.ticker);
  if (path === "/research") {
    if (!a.snapshotId && ["research_headline","research_position","research_earnings","price_key_moments"].includes(ref.tool)) {
      if (ref.tool === "research_headline" && a.url) {
        const original = safeUrl(a.url);
        if (original) return original;
      }
      params.set("unavailable","1");
      params.set("evidenceId",ref.evidenceId);
    }
    if (a.snapshotId && ["price_key_moments","research_position","research_earnings","research_headline","news_and_events","upcoming_events"].includes(ref.tool)) {
      params.set("snapshotId",a.snapshotId);
      params.set("evidence",ref.tool);
      params.set("evidenceId",ref.evidenceId);
      if (a.published_series_id) params.set("series",a.published_series_id);
      for (const key of ["date","start","end","eventId","event","field","timezone","eventTicker","market","limit","cursor","reference","observation","unselected"]) {
        if (a[key]) params.set(key,a[key]);
      }
      if (a.date) params.set("eventDate",a.date);
      if (ref.tool === "research_headline") params.set("field","/data/title");
      if (a.ticker) params.set("ticker",a.ticker);
    }
    if (a.index || a.index_id) {
      params.set("type","index"); params.set("index",a.index || a.index_id); params.set("view","price");
      if (a.indexRange) params.set("indexRange",a.indexRange);
      return path + "?" + params;
    }
    if (a.analystView) params.set("analystView",a.analystView);
    if (a.date && a.lens === "technical") { params.set("eventDate",a.date); params.set("priceRange","ALL"); params.set("interval","1d"); }
    if (a.event === "filing") params.set("notebook","filings");
    if (a.event === "rating_change") params.set("analystView","actions");
    const ticker = decisionEvent ? a.listing : a.ticker;
    if (ticker) params.set("ticker", ticker);
    if (citedEventKind(a.event)) {
      params.set("event", a.event);
      if (a.date) params.set("date", a.date);
      if (a.end) params.set("end", a.end);
      if (a.snapshotId) params.set("snapshotId", a.snapshotId);
      if (a.calendarEventId) params.set("calendarEventId", a.calendarEventId);
      if (a.eventId) { params.set("analystView", "events"); params.set("eventId", a.eventId); }
    }
    params.set("view", ref.tool === "read_valuation_evidence" ? "valuation" : a.lens || "overview");
  }
  // Saved rating-change observations used the former ratings tab.
  const section = a.analystView === "ratings" ? "actions" : a.analystView;
  if (eventSource && a.lens === "analyst" && ["actions", "events"].includes(section)) {
    params.set("analystView", section);
    if (a.snapshotId) params.set("snapshotId", a.snapshotId);
    if (a.calendarEventId) params.set("calendarEventId", a.calendarEventId);
    if (a.date) params.set("date", a.date);
    params.set("evidence",ref.tool);
    return path + "?" + params + "#research-" + section;
  }
  params.set("evidence", ref.tool);
  return path + "?" + params;
}
/** Restored conversations can split tool steps and the final text into
 * consecutive assistant messages. Keep evidence within the same user turn. */
export function displayTurns(messages: UIMessage[]) {
  const turns: UIMessage[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous?.role === "assistant" && message.role === "assistant") {
      previous.parts = [...previous.parts, ...message.parts];
    } else {
      turns.push({ ...message });
    }
  }
  return turns;
}
export function evidenceArguments(args: Json, output: Json): Record<string, string> {
  const effective = {...args, ...object(output.bound_arguments)};
  return Object.fromEntries(Object.entries(effective).filter((p): p is [string, string] => typeof p[1] === "string"));
}

export function completedEvidence(message: UIMessage) {
  const refs = new Map<string, { ref: Evidence; output: Json }>();
  const ambiguous = new Set<string>();
  for (const part of message.parts) {
    const tool = part.type === "dynamic-tool" ? part.toolName : part.type.startsWith("tool-") ? part.type.slice(5) : "";
    if (!("state" in part) || part.state !== "output-available" || !Object.hasOwn(destinations, tool)) continue;
    const output = object(part.output);
    const id = str(output.evidence_id);
    if (!id || ambiguous.has(id)) continue;
    const raw = object(object(part.input).args ?? part.input);
    const args = evidenceArguments(raw, output);
    if (tool === "upcoming_events" || tool === "news_and_events") {
      for (const key of ["cursor","limit"]) if (typeof raw[key] === "number") args[key] = String(raw[key]);
    }
    const ref: Evidence = { evidenceId: id, tool, arguments: args, source: tool === "read_research_lens" && lensWords[args.lens] || destinations[tool][1] };
    if (tool === "research_headline") {
      const story = object(output.data);
      const url = safeUrl(str(story.url));
      if (!url || !str(story.publisher)) continue;
      ref.publisher = str(story.publisher);
      ref.arguments = {...args, url};
    }
    const found = refs.get(id);
    if (found && (JSON.stringify(found.ref) !== JSON.stringify(ref) || JSON.stringify(found.output) !== JSON.stringify(output))) {
      refs.delete(id);
      ambiguous.add(id);
    } else refs.set(id, {ref, output});
  }
  return refs;
}
export function messageEvidence(message: UIMessage) {
  return new Map(Array.from(completedEvidence(message), ([id, result]) => [id, result.ref]));
}
export function chatContext(page: string, search: string, timezone: string) {
  const params = new URLSearchParams(search);
  const account = params.get("account");
  const scope = params.get("scope") || (account === "A" ? "invest" : account === "B" ? "isa" : account === "C" ? "cfd" : account);
  const ticker = params.get("ticker");
  const range = params.get("range") || (page === "research" ? params.get("priceRange") : null);
  const lens = params.get("type") === "index" && params.get("view") === "price" ? "technical" : params.get("view");
  return {
    page: ["overview", "holdings", "analytics", "sectors", "research", "review", "health", "settings"].includes(page) ? page : "overview", timezone,
    ...(["invest", "isa", "cfd", "household", "broker_total"].includes(scope ?? "") ? { scope } : ["overview","holdings","analytics","review"].includes(page) ? { scope: "broker_total" } : {}),
    ...(page === "research" && ticker && /^[a-z0-9^=._-]{1,32}$/i.test(ticker) ? { ticker: ticker.toUpperCase() } : {}),
    ...(page==="analytics" && ["VOO","QQQ","VT","ALL"].includes(params.get("benchmark") ?? "") ? {benchmark:params.get("benchmark")} : {}),
    ...(range && ["1D","1W","1M","3M","6M","YTD","1Y","2Y","ALL"].includes(range) ? { range } : {}),
    ...(page === "research" && lens && ["overview","fundamentals","technical","analyst","valuation","options","ledger"].includes(lens) ? { lens } : {}),
  };
}

/** Cached calendar times are instants. All-day dates and provider windows keep their original precision. */
export function observationText(line: components["schemas"]["LinkedObservation"], locale: "zh" | "en", timeZone: string) {
  const text = line[locale];
  const args = line.evidence.arguments;
  if (!args?.instant) return text;
  const day = line.evidence.tool === "sector_headline" ? args.start
    : line.evidence.tool === "upcoming_events" ? args.date : null;
  if (!day || !text.startsWith(day)) return text;
  const instant = new Date(args.instant);
  if (!Number.isFinite(instant.valueOf())) return text;
  return formatDateTimeInTimeZone(instant, locale, timeZone) + text.slice(day.length);
}
