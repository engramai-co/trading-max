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
  news_and_events: ["/research","disclosure"], research_earnings: ["/research", "financials"], research_headline: ["/research", "publisher"],
  data_freshness: ["/health", "health"], upcoming_events: ["/health", "calendar"],
};
const lensWords: Record<string, Evidence["source"]> = { technical: "technical", fundamentals: "financials", analyst: "analysts", ledger: "disclosure" };
export function evidenceHref(ref: Evidence): string | null {
  if (["upcoming_events","news_and_events"].includes(ref.tool) && (ref.arguments?.holdingTicker || ref.tool === "upcoming_events" && !ref.arguments?.rowCitation)) {
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
  const path = ref.arguments?.rowCitation ? "/research" : entry[0];
  const params = new URLSearchParams();
  const a = ref.arguments ?? {};
  if (path === "/analytics") {
    params.set("view", ref.tool === "period_performance" && (a.metric === "period_pnl_gbp" || a.range === "1D") ? "money" : "returns");
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
    if (ref.tool === "compare_benchmarks" && a.start && a.end) {
      params.set("returnFrom", a.start);
      params.set("returnTo", a.end);
    }
  }
  if (a.scope && a.scope !== "broker_total") {
    if (path === "/holdings" && ["invest", "isa"].includes(a.scope)) params.set("account", a.scope === "invest" ? "A" : "B");
    else if (path !== "/holdings") params.set("scope", a.scope);
  }
  if (ref.tool === "lookthrough_exposure") params.set("view", "lookthrough");
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
      for (const key of ["date","start","end","eventId","event","field","timezone","eventTicker","limit","cursor","reference","observation","unselected"]) {
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
    if (a.ticker) params.set("ticker", a.ticker);
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
    ...(["invest", "isa", "cfd", "household", "broker_total"].includes(scope ?? "") ? { scope } : ["overview","holdings","analytics"].includes(page) ? { scope: "broker_total" } : {}),
    ...(page === "research" && ticker && /^[a-z0-9^=._-]{1,32}$/i.test(ticker) ? { ticker: ticker.toUpperCase() } : {}),
    ...(range && ["1D","1W","1M","3M","6M","YTD","1Y","2Y","ALL"].includes(range) ? { range } : {}),
    ...(page === "research" && lens && ["overview","fundamentals","technical","analyst","valuation","options","ledger"].includes(lens) ? { lens } : {}),
  };
}

/** Cached calendar times are instants. All-day dates and provider windows keep their original precision. */
export function observationText(line: components["schemas"]["LinkedObservation"], locale: "zh" | "en", timeZone: string) {
  const text = line[locale];
  const args = line.evidence.arguments;
  if (line.evidence.tool !== "upcoming_events" || !args?.instant || !args.date || !text.startsWith(args.date)) return text;
  const instant = new Date(args.instant);
  if (!Number.isFinite(instant.valueOf())) return text;
  return formatDateTimeInTimeZone(instant, locale, timeZone) + text.slice(args.date.length);
}
