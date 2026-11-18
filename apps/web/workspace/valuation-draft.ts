import type { components } from "@/lib/api-schema";
import type { Preview, ScenarioInput } from "./research-facts";

export type DraftResult = components["schemas"]["DraftResult"];
export type Proposal = components["schemas"]["Proposal"];
export type DraftReview = components["schemas"]["DraftReview"];
export type Decision = DraftReview["decisions"][string][string];
export type DraftEvent = components["schemas"]["DraftEvent"];
export type DraftState = {
  result: DraftResult;
  review: DraftReview;
  before: Preview;
  basis: string;
};

export const inputKey = {
  revenue_cagr: "revenueCagr", target_fcf_margin: "targetFcfMargin", discount_rate: "discountRate",
  exit_fcf_multiple: "exitFcfMultiple", share_cagr: "shareCagr", ramp_years: "rampYears",
  initial_roe: "initialRoe", payout: "payout", terminal_pb: "terminalPb",
} as const satisfies Record<Proposal["field"], keyof ScenarioInput>;

type DraftBlockCode = keyof typeof draftBlockMessages;

export function reverseDraftBlock(preview: Preview): string | null {
  const reason = preview.reverseMetric ? preview.reverseReason : preview.impliedGrowthReason;
  if (reason) return reason;
  if (!preview.scenarios.base) return "no-valuation-range-to-save";
  const reading = preview.reverseMetric ? preview.reverseValue : preview.impliedGrowth;
  const bound = preview.reverseMetric ? preview.reverseBound : preview.impliedGrowthBound;
  return reading == null && !bound ? "valuation-reverse-withheld" : null;
}

const draftBlockMessages = {
  "currency-conversion-unavailable": ["缺少报表币种到报价币种的汇率", "The reporting-to-quote exchange rate is missing"],
  "opening-cash-required-for-burn": ["估算融资所需的期初现金余额缺失", "Opening cash is missing for the financing calculation"],
  "positive-common-equity-and-common-income-required": ["需要同期普通股净利润与正的普通股净资产", "Common earnings and positive common equity are required for the same period"],
  "positive-target-and-multiple-required": ["目标利润率与退出倍数须为正", "Target margin and exit multiple must be positive"],
  "target-margin-not-unique": ["融资摊薄下无法确定唯一的目标利润率", "Financing dilution prevents a unique target margin"],
  "non-monotonic-or-flat-cashflows": ["现金流路径无法确定唯一的隐含值", "The cash-flow path does not imply a unique value"],
  "valuation-reverse-withheld": ["无法确定现价隐含值", "The price-implied reading is unavailable"],
  "no-valuation-range-to-save": ["仅有反推结果，没有可起草的估值区间", "Only the price-implied reading is available. There is no scenario range to draft."],
  "company-model-not-applicable": ["此证券不适用公司估值模型", "Company valuation does not apply to this security"],
  "complete-ttm-currency-and-share-count-required": ["此模型缺少完整同期报表、报价或上市股数", "Matching statements, a quote and verified listing shares are required"],
  "valuation-inputs-unavailable": ["缺少所选证券的估值输入", "Valuation inputs are missing for this security"],
} as const;

export function draftBlockMessage(code: string, t: (zh: string, en: string) => string, fallback?: DraftBlockCode) {
  const key = Object.hasOwn(draftBlockMessages, code) ? code as DraftBlockCode : fallback;
  const message = key && draftBlockMessages[key];
  return message ? t(message[0], message[1]) : null;
}
