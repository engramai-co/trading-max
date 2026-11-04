/**
 * Chinese names for analyst ratings and SEC filing forms, shared by research and
 * review so one security reads the same everywhere. English keeps the provider's
 * own term, and anything unknown passes through unchanged. Each entry pairs the
 * provider's term with its Chinese name.
 */
type Copy = (zh: string, en: string) => string;

const ratings = new Map<string, string>([
  ["buy", "买入"],
  ["strong buy", "强烈买入"],
  ["conviction buy", "强烈买入"],
  ["speculative buy", "投机性买入"],
  ["long term buy", "长期买入"],
  ["top pick", "首选"],
  ["outperform", "跑赢大盘"],
  ["market outperform", "跑赢大盘"],
  ["sector outperform", "跑赢行业"],
  ["overweight", "增持"],
  ["accumulate", "增持"],
  ["add", "增持"],
  ["positive", "看好"],
  ["hold", "持有"],
  ["neutral", "中性"],
  ["equal weight", "同步大市"],
  ["sector weight", "同步大市"],
  ["peer perform", "同步大市"],
  ["in line", "同步大市"],
  ["market perform", "与大盘持平"],
  ["perform", "与大盘持平"],
  ["sector perform", "与行业持平"],
  ["underperform", "跑输大盘"],
  ["market underperform", "跑输大盘"],
  ["sector underperform", "跑输行业"],
  ["underweight", "减持"],
  ["reduce", "减持"],
  ["sell", "卖出"],
  ["strong sell", "强烈卖出"],
  ["negative", "看淡"],
]);

/** An analyst rating such as "Outperform" or "Equal-Weight". */
export function ratingLabel(grade: string, t: Copy) {
  const name = ratings.get(grade.trim().toLowerCase().replace(/[\s_-]+/g, " "));
  return name ? t(name, grade) : grade;
}

const filings = new Map<string, string>([
  ["8-K", "重大事项公告"],
  ["10-Q", "季报"],
  ["10-K", "年报"],
  ["6-K", "临时报告"],
  ["20-F", "年报"],
  ["40-F", "年报"],
  ["S-1", "招股书"],
  ["F-1", "招股书"],
  ["424B", "招股说明书"],
  ["DEF 14A", "股东大会委托书"],
  ["SC 13D", "持股披露"],
  ["SC 13G", "持股披露"],
  ["4", "内部人交易"],
]);

/** An SEC form such as "8-K" or "10-Q/A"; amendments say so. */
export function filingLabel(form: string, t: Copy) {
  const code = form.trim().toUpperCase().replace(/\s+/g, " ");
  const amended = code.endsWith("/A");
  const base = amended ? code.slice(0, -2) : code;
  // Prospectus supplements come numbered: 424B2, 424B5 …
  const name = filings.get(/^424B\d*$/.test(base) ? "424B" : base);
  if (!name) return form;
  return t(name + (amended ? t("（修订）", " (amended)") : ""), form);
}
