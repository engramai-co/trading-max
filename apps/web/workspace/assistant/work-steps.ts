import type { UIMessage } from "ai";
import type { Locale } from "@/components/locale-provider";
import { object, str } from "../data";
import { readableDates } from "./evidence";
import { formatTurnContext } from "./turn-context";

type Words = readonly [zh: string, en: string];

export type WorkStepStatus = "running" | "complete" | "unavailable";

export type WorkStep = {
  id: string;
  label: string;
  source?: string;
  detail?: string;
  status: WorkStepStatus;
};

const FALLBACK_STEP: Words = ["读取工作区数据", "Read workspace data"];

const TOOL_STEP_LABELS: Record<string, Words> = {
  portfolio_overview: ["读取账户记录", "Read account records"],
  list_holdings: ["读取持仓明细", "Read holdings"],
  position_detail: ["查看持仓详情", "Read position details"],
  lookthrough_exposure: ["读取穿透敞口", "Read look-through exposure"],
  period_performance: ["核对区间收益", "Check period performance"],
  compare_benchmarks: ["对比基准回报", "Compare benchmarks"],
  read_research_lens: ["读取研究资料", "Read research lens"],
  read_valuation_evidence: ["核对估值依据", "Check valuation evidence"],
  data_freshness: ["检查数据状态", "Check data freshness"],
  recent_decisions: ["读取近期交易", "Read recent decisions"],
  daily_returns: ["核对每日收益", "Check daily returns"],
  holding_fx_split: ["拆分持股汇率影响", "Split holding FX effect"],
  dated_exposure: ["核对历史敞口", "Check dated exposure"],
  decision_timing_and_habits: ["核对交易时点与习惯", "Check trade timing and habits"],
  review_patterns: ["核对复盘模式", "Check review patterns"],
  price_key_moments: ["核对价格关键时刻", "Check price key moments"],
  research_earnings: ["读取财报与预期", "Read earnings and estimates"],
  research_position: ["核对证券走势与持仓", "Check security price and position"],
  research_headline: ["读取相关报道", "Read dated headlines"],
  company_profile: ["读取公司简介", "Read company profile"],
  news_and_events: ["读取新闻与事件", "Read news and events"],
  upcoming_events: ["读取日程与事件", "Read upcoming events"],
  selected_money: ["核对所选区间盈亏", "Check selected period P&L"],
  selected_daily: ["核对所选区间日收益", "Check selected daily returns"],
  selected_fx: ["核对所选区间汇率影响", "Check selected FX effect"],
  selected_exposure: ["核对所选穿透敞口", "Check selected exposure"],
  market_sector: ["读取板块行情", "Read sector moves"],
  sector_headline: ["读取板块报道", "Read sector headlines"],
  global_map: ["读取全球市场贡献", "Read global market moves"],
  exposure_benchmark: ["对比基准权重", "Compare benchmark weights"],
  update_issue: ["检查更新记录", "Check update record"],
};

const STEP_SOURCES: Record<string, Words> = {
  research_position: ["行情", "Prices"],
  price_key_moments: ["技术", "Technicals"],
  research_headline: ["新闻", "News"],
  news_and_events: ["新闻", "News"],
  decision_timing_and_habits: ["复盘", "Review"],
  recent_decisions: ["复盘", "Review"],
  research_earnings: ["财报", "Financials"],
};

const STATUS_LABELS: Record<WorkStepStatus, Words> = {
  running: ["进行中", "Running"],
  complete: ["已完成", "Complete"],
  unavailable: ["暂不可用", "Unavailable"],
};

export const WORK_TOOL_NAMES = Object.keys(TOOL_STEP_LABELS);

export function toolStepLabel(toolName: string, locale: Locale): string {
  const words = Object.hasOwn(TOOL_STEP_LABELS, toolName)
    ? TOOL_STEP_LABELS[toolName]
    : FALLBACK_STEP;
  return locale === "en" ? words[1] : words[0];
}

export function stepStatusLabel(status: WorkStepStatus, locale: Locale): string {
  const words = STATUS_LABELS[status];
  return locale === "en" ? words[1] : words[0];
}

/** Only the recorded work item contributes its displayed scope. */
export function toolStepDetail(args: unknown, result: unknown, locale: Locale, timeZone: string) {
  const output = object(result);
  const data = object(output.data);
  const target = {...object(object(args).args ?? args), ...object(output.bound_arguments)};
  const ticker = str(target.ticker) || str(data.ticker);
  const range = str(target.range) || str(data.range);
  const date = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(str(value)) ? str(value) : "";
  const day = date(target.date);
  const start = date(target.start) || date(data.window_start) || date(data.start);
  const end = date(target.end) || date(data.window_end) || date(data.end);
  const window = day || (start && end && start !== end ? start + " – " + end : end || start);
  const scope = formatTurnContext({scope: str(output.scope) || str(target.scope)}, locale, timeZone);
  return [
    /^[\p{L}\p{N}^=._-]{1,32}$/u.test(ticker) && ticker,
    /^(?:[1-9]\d?[DWMY]|YTD|ALL|MAX)$/.test(range) && range,
    window && readableDates(window, locale, timeZone),
    scope,
  ].filter(Boolean).join(" · ");
}

/**
 * Map stream or persisted tool parts into user-facing work steps.
 * Raw tool names, inputs, payloads, and provider internals never enter the result.
 */
export function extractWorkSteps(
  message: UIMessage | null | undefined,
  streaming: boolean,
  locale: Locale,
  timeZone = "Europe/London",
): WorkStep[] {
  if (!message) return [];
  const steps: WorkStep[] = [];
  const indexById = new Map<string, number>();

  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    const toolName =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.startsWith("tool-")
          ? part.type.slice(5)
          : "";
    if (!toolName || !("state" in part)) continue;

    const callId = "toolCallId" in part && typeof part.toolCallId === "string"
      ? part.toolCallId
      : `step-${i}`;
    let status: WorkStepStatus;
    if (part.state === "output-error" || part.state === "output-denied") {
      status = "unavailable";
    } else if (part.state === "output-available") {
      const output = object("output" in part ? part.output : undefined);
      const outputStatus = str(output.status);
      status =
        outputStatus === "unavailable" || outputStatus === "not_applicable" || outputStatus === "error"
          ? "unavailable"
          : "complete";
    } else {
      status = streaming ? "running" : "unavailable";
    }

    const source = Object.hasOwn(STEP_SOURCES, toolName) ? STEP_SOURCES[toolName][locale === "en" ? 1 : 0] : undefined;
    const detail = toolStepDetail("input" in part ? part.input : undefined, "output" in part ? part.output : undefined, locale, timeZone);
    const step: WorkStep = {
      ...(source && { source }),
      ...(detail && { detail }),
      id: callId,
      label: toolStepLabel(toolName, locale),
      status,
    };
    const existing = indexById.get(callId);
    if (existing !== undefined) {
      steps[existing] = step;
    } else {
      indexById.set(callId, steps.length);
      steps.push(step);
    }
  }

  return steps;
}
