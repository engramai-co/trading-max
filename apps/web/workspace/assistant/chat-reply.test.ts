import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { formatCalendarDate } from "@/ui/formatters";
import { replyText, verifiedLines } from "./chat-reply";
import { citationPreview } from "./evidence";
import { beginTurnAttempt, INITIAL_TURN_STORE, settleTurnAttempt, turnAnnouncementText } from "./turn-state";
import research from "./research-figures.fixture.json";
import review from "./__fixtures__/review-tools.json";
import dividend from "../../tests/fixtures/historical-dividend.json";

type Figure = {tool: string; pointer: string; output: Record<string, unknown>};
const zone = "Europe/London";
const smallMoves = [
  {change: -0.000001, direction: {en:"down less than 0.1%", zh:"下跌不到 0.1%"}, tone: "loss"},
  {change: 0.000001, direction: {en:"up less than 0.1%", zh:"上涨不到 0.1%"}, tone: "gain"},
];

function reply(...figures: Figure[]): UIMessage {
  const toolParts = figures.map(({tool, output}, index) => ({
    type: "dynamic-tool" as const, toolName: tool, toolCallId: "call-" + index, state: "output-available" as const,
    input: {}, output: {status: "ok", snapshot_id: "synthetic", ...output, evidence_id: "ev_" + index},
  }));
  const facts = figures.map(({pointer}, index) => "{{" + pointer + "}} [ev_" + index + "]");
  if (facts.length === 1) facts.push("{{history}} [inference]");
  return {id: "fixture-reply", role: "assistant", parts: [...toolParts, {type: "text", text: facts.join("\n")}]};
}

function price(ticker: string, change = -0.0625): Figure {
  return {tool: "research_position", pointer: "/data/close",
    output: {...research.research_position, data: {...research.research_position.data, ticker, change}}};
}

function volume(ticker: string): Figure {
  return {tool: "price_key_moments", pointer: "/data/items/0/volume_z_score",
    output: {data: {ticker, items: [{date: "2026-02-03", volume_z_score: -2.125}]}}};
}

function headline(ticker: string): Figure {
  return {tool: "research_headline", pointer: "/data/title",
    output: {...research.research_headline, data: {...research.research_headline.data, ticker, date: "2026-02-03"}}};
}

const cases = [
  {name: "price", figure: price("TEST"), en: ["TEST", "US$30.00", "down 6.25%"], zh: ["TEST", "US$30.00", "下跌 6.25%"]},
  {name: "technical", figure: volume("TEST"),
    en: ["TEST", "2.13 standard deviations below", "20 trading days"],
    zh: ["TEST", "20 个交易日", "低 2.13 个标准差"]},
  {name: "technical returns", figure: {tool: "price_key_moments", pointer: "/data/following/1/return_fraction", output: research.price_key_moments},
    en: ["TEST", "split- and dividend-adjusted return", "down 11.76%"],
    zh: ["TEST", "拆股及股息调整后回报", "下跌 11.76%"]},
  {name: "news", figure: headline("TEST"),
    en: ["TEST", "Issuer publishes outlook"], zh: ["TEST", "Issuer publishes outlook"], publisher: "Example Wire"},
  {name: "review", figure: {tool: "decision_timing_and_habits", pointer: "/data/items/0/security_return", output: review.decision},
    en: ["TEST", "GBP total return (incl. dividends)", "up 9%", "20 trading days"],
    zh: ["TEST", "以英镑计的总回报（含分红）", "上涨 9%", "20 个交易日"]},
  {name: "review amount", figure: {tool: "decision_timing_and_habits", pointer: "/data/items/0/effect_gbp",
    output: {...review.decision, data: {...review.decision.data, items: [{...review.decision.data.items[0], effect_gbp: -18}]}}},
    en: ["TEST", "Decision effect", "−£18.00"], zh: ["TEST", "决策影响", "−£18.00"]},
  {name: "account", figure: {tool: "period_performance", pointer: "/data/period_pnl_gbp",
    output: {scope: "isa", data: {period_pnl_gbp: -18.125, window_start: "2026-02-01", window_end: "2026-02-03"}}},
    en: ["ISA", "Period net P&L", "−£18.13"], zh: ["ISA", "本期净盈亏", "−£18.13"]},
  {name: "valuation", figure: {tool: "read_valuation_evidence", pointer: "/data/items/0/value",
    output: {data: {ticker: "TEST", items: [{metric: "EPS", unit: "perShare", state: "available", currency: "GBP", value: -0.12556}]}}},
    en: ["TEST", "EPS", "−£0.1256/share"], zh: ["TEST", "EPS", "−£0.1256/股"]},
  {name: "event", figure: {tool: "news_and_events", pointer: "/data/items/0/amount", output: dividend},
    en: ["SYNT", "Dividend", "USD 0.375 per share"], zh: ["SYNT", "股息", "USD 0.375 每股"]},
];

describe.each(["en", "zh"] as const)("verified reply template audit (%s)", locale => {
  it.each(cases)("keeps the $name subject and measurement", ({figure, publisher, ...words}) => {
    const text = reply(figure);
    const [line] = verifiedLines(text, locale, zone);
    const copy = (zh: string, en: string) => locale === "zh" ? zh : en;
    for (const expected of words[locale]) expect(line.text).toContain(expected);
    expect(line.evidence).toMatchObject({tool: figure.tool, ...(publisher && {publisher})});
    expect(line.text).not.toMatch(/-£|股价涨|股价跌/);
    expect(replyText(line, locale, zone, copy)).toContain(words[locale][0]);
  });

  it("reuses the day only while the subject matches, including in copy and the live announcement", () => {
    const message = reply(price("AAA"), volume("AAA"), headline("BBB"), volume("BBB"));
    const lines = verifiedLines(message, locale, zone);
    const copy = (zh: string, en: string) => locale === "zh" ? zh : en;
    expect(lines).toHaveLength(4);
    expect(lines[0].text).toContain("AAA");
    expect(lines[1].text).not.toMatch(/AAA|2026-02-03/);
    expect(lines[2].text).toContain("BBB");
    expect(lines[2].text).toContain("2026-02-03");
    expect(lines[3].text).not.toMatch(/BBB|2026-02-03/);
    const copied = lines.map(line => replyText(line, locale, zone, copy));
    expect(copied[2]).toContain("BBB");
    const store = beginTurnAttempt(INITIAL_TURN_STORE, {
      attemptId:1, userMessageId:"question", prompt:"Compare AAA and BBB", requestContext:{}, turnContext:{}, card:null,
    });
    const { announcement } = settleTurnAttempt(store, {
      attemptId:1, assistantMessage:message, isAbort:false, isDisconnect:false, isError:false,
      sawFinish:true, sawAbort:false, locale, timeZone:zone,
    });
    expect(announcement && turnAnnouncementText(announcement, copy)).toBe(locale === "zh" ? "AAA、BBB 的回复已就绪。" : "Response ready for AAA, BBB.");
  });

  it.each(smallMoves)("keeps the direction of a small move ($change)", ({change, direction, tone}) => {
    const [line] = verifiedLines(reply(price("TEST", change)), locale, zone);
    expect(line.move).toEqual({text: direction[locale], tone});
    expect(line.text).toContain(direction[locale]);
  });

  it.each(smallMoves)("keeps a small move ($change) and its verified dates in citation previews", ({change, direction}) => {
    const start = "2026-01-30";
    const end = "2026-02-03";
    const moments = {data: {
      ticker:"TEST",
      items:[{date: end, move_fraction: change}],
      following:[{start, date: end, return_fraction: change}],
    }};
    const observations = [
      [{tool:"price_key_moments", pointer:"/data/items/0/move_fraction", output:moments}, [end]],
      [{tool:"price_key_moments", pointer:"/data/following/0/return_fraction", output:moments}, [start, end]],
      [{tool:"research_position", pointer:"/data/change", output:{data:{ticker:"TEST", start, end, change}}}, [start, end]],
    ] as const;
    for (const [figure, dates] of observations) {
      const [line] = verifiedLines(reply(figure), locale, zone);
      const preview = citationPreview(line.evidence!, locale, zone);
      expect(line.text).toContain(direction[locale]);
      expect.soft(preview?.fact).toContain(direction[locale]);
      expect.soft(preview?.date).toBe(dates.map(date => formatCalendarDate(date, locale)).join(" – "));
      expect(preview?.href).toContain("snapshotId=synthetic");
    }
  });
});
