import type { components } from "@/lib/api-schema";
import type { UIMessage } from "ai";
import { object, str } from "../data";

export const sourceWords = {
  account: ["账户", "Account"], broker: ["券商", "Broker"], holdings: ["持仓", "Holdings"],
  exposure: ["穿透", "Exposure"], market: ["行情", "Market"], technical: ["技术", "Technicals"],
  financials: ["财报", "Financials"], analysts: ["分析师", "Analysts"], disclosure: ["披露", "Disclosure"],
  review: ["复盘", "Review"], health: ["数据状态", "Data status"], calendar: ["日历", "Calendar"],
  inference: ["推断", "Inference"], publisher: ["披露", "Disclosure"],
} as const;
export type Evidence = components["schemas"]["ReadingEvidence"];
export type Reading = components["schemas"]["RoleReading"];

const destinations: Record<string, [string, Evidence["source"]]> = {
  portfolio_overview: ["/", "account"], period_performance: ["/analytics", "account"], compare_benchmarks: ["/analytics", "market"],
  list_holdings: ["/holdings", "holdings"], position_detail: ["/holdings", "holdings"], lookthrough_exposure: ["/holdings", "exposure"],
  read_research_lens: ["/research", "market"], read_valuation_evidence: ["/research", "financials"], recent_decisions: ["/review", "review"],
  data_freshness: ["/health", "health"],
};
const lensWords: Record<string, Evidence["source"]> = { technical: "technical", fundamentals: "financials", analyst: "analysts", ledger: "disclosure" };
export function evidenceHref(ref: Evidence) {
  const entry = destinations[ref.tool];
  if (!entry) return null;
  const [path] = entry;
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
    if (a.ticker) params.set("ticker", a.ticker);
    if (["earnings", "earningsWindow", "exDividend"].includes(a.event)) {
      params.set("event", a.event);
      if (a.date) params.set("date", a.date);
      if (a.end) params.set("end", a.end);
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
export function messageEvidence(message: UIMessage) {
  const refs = new Map<string, Evidence>();
  for (const part of message.parts) {
    const tool = part.type === "dynamic-tool" ? part.toolName : part.type.startsWith("tool-") ? part.type.slice(5) : "";
    if (!("output" in part) || !destinations[tool]) continue;
    const id = str(object(part.output).evidence_id);
    if (!id) continue;
    const raw = object(object(part.input).args ?? part.input);
    const args = Object.fromEntries(Object.entries(raw).filter((p): p is [string, string] => typeof p[1] === "string"));
    refs.set(id, { evidenceId: id, tool, arguments: args, source: tool === "read_research_lens" && lensWords[args.lens] || destinations[tool][1] });
  }
  return refs;
}
export function chatContext(page: string, search: string, timezone: string) {
  const params = new URLSearchParams(search);
  const account = params.get("account");
  const scope = params.get("scope") || (account === "A" ? "invest" : account === "B" ? "isa" : account === "C" ? "cfd" : account);
  const ticker = params.get("ticker");
  const range = params.get("range");
  const lens = params.get("view");
  return {
    page: ["overview", "holdings", "analytics", "sectors", "research", "review", "health", "settings"].includes(page) ? page : "overview", timezone,
    ...(["invest", "isa", "cfd", "household"].includes(scope ?? "") ? { scope } : ["overview","holdings","analytics"].includes(page) ? { scope: "broker_total" } : {}),
    ...(page === "research" && ticker && /^[a-z0-9^=._-]{1,32}$/i.test(ticker) ? { ticker: ticker.toUpperCase() } : {}),
    ...(range && ["1D","1W","1M","3M","6M","YTD","1Y","2Y","ALL"].includes(range) ? { range } : {}),
    ...(page === "research" && lens && ["overview","fundamentals","technical","analyst","valuation","options","ledger"].includes(lens) ? { lens } : {}),
  };
}

/** A reply is visible only with two to four lines whose trailing references belong to this turn. */
export function verifiedLines(message: UIMessage) {
  const references = messageEvidence(message);
  const raw = message.parts.filter(p => p.type === "text").map(p => p.text).join("").trim();
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 4) return [];
  const result: { text: string; evidence: Evidence | null }[] = [];
  for (const line of lines) {
    const match = /^(.+?)\s*\[(inference|ev_[a-zA-Z0-9_-]+)\]$/.exec(line);
    if (!match || /\[(?:ev_|inference\])/.test(match[1])) return [];
    const evidence = references.get(match[2]);
    if (!evidence && (match[2] !== "inference" || /\p{N}/u.test(match[1]))) return [];
    result.push({text:match[1].trim(), evidence:evidence ?? null});
  }
  return result;
}
