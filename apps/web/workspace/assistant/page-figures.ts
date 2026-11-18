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
  const t = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (
    tool === "update_issue" &&
    ["last_publication", "finished_at"].includes(field) &&
    !group &&
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  ) {
    return [
      field === "finished_at"
        ? t("更新结束", "Update ended")
        : t("最近发布", "Last publication"),
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
      t("新闻标题", "Headline"),
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
    const label = t("扣除资金流的净盈亏", "Cash-flow-adjusted net P&L");
    const proxy = ["cfd", "household"].includes(scope)
      ? t("含 CFD 已实现现金权益代理", "including realised CFD cash equity")
      : "";
    return [
      [
        label,
        proxy,
        data.estimated === true ? t("含估算", "includes estimates") : "",
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
      ? [benchmark + " · " + t("权重", "weight"), percent(value, false, 2)]
      : null;
  }
  if (tool === "daily_returns") {
    if (field === "window_twr_fraction" && !group)
      return [
        t("组合时间加权收益", "Portfolio time-weighted return"),
        percent(value, true, 2),
      ];
    const basis = data.benchmark_basis === "auto_adjusted_close"
      ? t("复权收盘价", "adjusted closing prices")
      : data.benchmark_basis === "adjusted_price_gbp" ? t("复权价格", "adjusted prices") : null;
    if (
      group === "window_benchmarks" &&
      ["VOO", "QQQ", "VT"].includes(field) &&
      data.benchmark_currency &&
      basis
    )
      return [
        [field, str(data.benchmark_currency), basis].join(
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
          ? t("区间最低已观测日收益", "Lowest observed daily return")
          : t("组合日收益", "Daily portfolio return"),
        percent(value, true, 2),
      ];
    if (
      field === "worst_rank" &&
      ["items", "worst_day"].includes(group ?? "") &&
      Number.isSafeInteger(value) &&
      value > 0
    )
      return [
        t("日收益由低至高排名", "Rank from lowest daily return"),
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
        t("持股汇率影响", "Held-share currency effect"),
        currency(value, "GBP", 2),
      ];
    if (field === "local_price_effect_gbp")
      return [
        t("持股价格影响", "Held-share price effect"),
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
      return [t("本时段涨跌", "Session move"), percent(value, true, 2)];
    if (field === "contribution" && data.weight_stale !== true) {
      const index = tool === "global_map" ? "MSCI ACWI" : "MSCI World";
      return [
        index + " · " + t("估算贡献", "estimated contribution"),
        formatNumber(value * 100, locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          signDisplay: "exceptZero",
        }) + t(" 个百分点", " pp"),
      ];
    }
    if (tool === "market_sector" && field === "exposure")
      return [
        t("匹配的组合敞口", "Matched exposure"),
        currency(value, "GBP", 2),
      ];
    if (tool === "market_sector" && field === "weight" && data.weights_as_of)
      return [
        "MSCI World (SWDA) · " +
          t("权重", "weight") +
          (data.weight_stale ? t("（待更新）", " (stale)") : ""),
        percent(value, false, 2),
      ];
    const breadth: Record<string, string> = {
      up: t("上涨成分", "Advancing constituents"),
      flat: t("持平成分", "Flat constituents"),
      down: t("下跌成分", "Declining constituents"),
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
      return [t("已完成阶段", "Completed stages"), number(value, 0)];
    if (field === "stages")
      return [t("已记录阶段", "Recorded stages"), number(value, 0)];
  }
  return null;
}
