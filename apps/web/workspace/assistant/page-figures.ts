import type { Locale } from "@/components/locale-provider";
import { formatDateTime, formatNumber } from "@/ui/formatters";
import { currency, number, percent, str, type Json } from "../data";

export type ToolField = {
  data: Json;
  parent: Json;
  group?: string;
  field: string;
  value: unknown;
};

/** Format the page tools' units only where their own schemas publish them. */
export function formatPageField(
  tool: string,
  row: ToolField,
  locale: Locale,
  scope: string,
  timeZone: string,
): string[] | null {
  const { data, parent, field, group, value } = row;
  const t = (en: string, zh: string) => (locale === "en" ? en : zh);
  if (
    tool === "update_issue" &&
    ["last_publication", "finished_at"].includes(field) &&
    !group &&
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  ) {
    return [
      field === "finished_at"
        ? t("Update ended", "更新结束")
        : t("Last publication", "最近发布"),
      formatDateTime(value, locale, timeZone),
    ];
  }
  if (
    tool === "news_and_events" &&
    group === "items" &&
    parent.kind === "news" &&
    field === "title_en" &&
    typeof parent.title_en === "string" &&
    parent.publisher &&
    parent.source_url
  ) {
    return [
      t("Headline", "新闻标题"),
      str(locale === "en" ? parent.title_en : parent.title_zh) ||
        parent.title_en,
    ];
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (
    tool === "selected_money" &&
    field === "pnl" &&
    !group &&
    data.currency === "GBP" &&
    data.start &&
    data.end
  ) {
    const label = t("Cash-flow-adjusted net P&L", "扣除资金流的净盈亏");
    const proxy = ["cfd", "household"].includes(scope)
      ? t("including realised CFD cash equity", "含 CFD 已实现现金权益代理")
      : "";
    return [
      [
        label,
        proxy,
        data.estimated === true ? t("includes estimates", "含估算") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      currency(value, "GBP", 2),
    ];
  }
  if (
    tool === "exposure_benchmark" &&
    field === "weight" &&
    !group &&
    data.as_of
  ) {
    const benchmark =
      data.dimension === "country"
        ? "MSCI ACWI (SSAC)"
        : data.dimension === "sector"
          ? "MSCI World (SWDA)"
          : "";
    return benchmark
      ? [benchmark + " · " + t("weight", "权重"), percent(value, false, 2)]
      : null;
  }
  if (tool === "daily_returns") {
    if (field === "window_twr_fraction" && !group)
      return [
        t("Portfolio time-weighted return", "组合时间加权收益"),
        percent(value, true, 2),
      ];
    if (
      group === "window_benchmarks" &&
      ["VOO", "QQQ", "VT"].includes(field) &&
      data.benchmark_currency &&
      data.benchmark_basis
    )
      return [
        [field, str(data.benchmark_currency), str(data.benchmark_basis)].join(
          " · ",
        ),
        percent(value, true, 2),
      ];
    if (
      ["items", "worst_day"].includes(group ?? "") &&
      field === "return_fraction"
    )
      return [
        group === "worst_day"
          ? t("Lowest observed daily return", "区间最低已观测日收益")
          : t("Daily portfolio return", "组合日收益"),
        percent(value, true, 2),
      ];
    if (
      field === "worst_rank" &&
      ["items", "worst_day"].includes(group ?? "") &&
      Number.isSafeInteger(value) &&
      value > 0
    )
      return [
        t("Rank from lowest daily return", "日收益由低至高排名"),
        number(value, 0),
      ];
  }
  if (
    tool === "holding_fx_split" &&
    ["accounts", "items"].includes(group ?? "") &&
    data.currency === "GBP"
  ) {
    if (field === "fx_effect_gbp")
      return [
        t("Held-share currency effect", "持股汇率影响"),
        currency(value, "GBP", 2),
      ];
    if (field === "local_price_effect_gbp")
      return [
        t("Held-share price effect", "持股价格影响"),
        currency(value, "GBP", 2),
      ];
  }
  if (tool === "market_sector" || tool === "global_map") {
    if (
      tool === "global_map" &&
      (group !== "markets" || parent.not_open !== false)
    )
      return null;
    if (field === "move")
      return [t("Session move", "本时段涨跌"), percent(value, true, 2)];
    if (field === "contribution" && data.weight_stale !== true) {
      const index = tool === "global_map" ? "MSCI ACWI" : "MSCI World";
      return [
        index + " · " + t("estimated contribution", "估算贡献"),
        formatNumber(value * 100,locale,{minimumFractionDigits:2,maximumFractionDigits:2,signDisplay:"exceptZero"}) + t(" pp", " 个百分点"),
      ];
    }
    if (tool === "market_sector" && field === "exposure")
      return [
        t("Matched exposure", "匹配的组合敞口"),
        currency(value, "GBP", 2),
      ];
    if (tool === "market_sector" && field === "weight" && data.weights_as_of)
      return [
        "MSCI World (SWDA) · " +
          t("weight", "权重") +
          (data.weight_stale ? t(" (stale)", "（待更新）") : ""),
        percent(value, false, 2),
      ];
    const breadth: Record<string, string> = {
      up: t("Advancing constituents", "上涨成分"),
      flat: t("Flat constituents", "持平成分"),
      down: t("Declining constituents", "下跌成分"),
    };
    if (
      group === "breadth" &&
      Object.hasOwn(breadth, field) &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      return [breadth[field], number(value, 0)];
  }
  if (
    tool === "update_issue" &&
    !group &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    if (field === "completed")
      return [t("Completed stages", "已完成阶段"), number(value, 0)];
    if (field === "stages")
      return [t("Recorded stages", "已记录阶段"), number(value, 0)];
  }
  return null;
}
