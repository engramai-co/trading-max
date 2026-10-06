import type { TechnicalScoreFactor, TechnicalScoreGroup, TechnicalScoreSummary } from "@/lib/types";

export const technicalGroups: Record<string, [string, string]> = {
  trend: ["趋势结构", "Trend structure"],
  momentum: ["动量变化", "Momentum"],
  relative: ["相对表现", "Relative performance"],
  volume: ["量能配合", "Volume support"],
};

export function impactTone(value: number | null | undefined) {
  return value == null || value === 0 ? "" : value > 0 ? "mx-up" : "mx-down";
}

export function groupState(group: TechnicalScoreGroup, t: (zh: string, en: string) => string) {
  const value = group.contribution;
  return value == null ? t("缺少读数", "Unavailable")
    : value === 0 ? t("中性 / 分歧", "Neutral / mixed")
    : value > 0 ? t("偏强", "Positive") : t("偏弱", "Negative");
}

export function stateName(data: TechnicalScoreSummary, t: (zh: string, en: string) => string) {
  if (data.score == null) return t("暂无评分", "Not scored");
  const states: [string, string][] = [
    ["强势趋势", "Strong trend"],
    ["偏强", "Positive"],
    ["中性/分歧", "Neutral / mixed"],
    ["中性", "Neutral / mixed"],
    ["偏弱", "Weak"],
    ["弱势/趋势破坏", "Weak / broken trend"],
  ];
  const state = states.find(([zh]) => zh === data.state);
  return state ? t(...state) : data.state;
}

export function keyImpacts(data?: TechnicalScoreSummary | null) {
  const groups = data?.scoreBreakdown?.groups ?? [];
  const adverse = groups.filter((g) => g.contribution != null && g.contribution < 0)
    .sort((a, b) => a.contribution! - b.contribution!)[0];
  const favorable = groups.filter((g) => g.contribution != null && g.contribution > 0)
    .sort((a, b) => b.contribution! - a.contribution!)[0];
  return [adverse, favorable].filter((g): g is TechnicalScoreGroup => Boolean(g));
}

export function factorMeaning(f: TechnicalScoreFactor, t: (zh: string, en: string) => string): string {
  if (f.contribution == null) {
    const labels: Record<string, [string, string]> = {
      sma_cross: ["均线排列", "Moving-average alignment"],
      sma_slope: ["SMA50 斜率", "SMA50 slope"],
      macd_signal: ["MACD / 信号线", "MACD / signal"],
      macd_histogram: ["MACD 柱值", "MACD histogram"],
      up_down_volume: ["涨跌日量比", "Up/down volume ratio"],
    };
    const label = labels[f.key];
    return `${label ? t(...label) : f.key.toUpperCase().replace("_63D", " · 63D")} · ${t("缺少读数", "Reading unavailable")}`;
  }
  const above = f.value != null && f.reference != null && f.value > f.reference;
  if (["sma20", "sma50", "sma200"].includes(f.key)) {
    return (above ? t("收盘高于", "Close above") : t("收盘不高于", "Close at or below")) + ` ${f.key.toUpperCase()}`;
  }
  switch (f.key) {
    case "sma_cross": return above ? t("SMA50 高于 SMA200", "SMA50 above SMA200")
      : t("SMA50 不高于 SMA200", "SMA50 at or below SMA200");
    case "sma_slope": return above ? t("SMA50 向上", "SMA50 rising")
      : t("SMA50 持平或向下", "SMA50 flat or falling");
    case "adx": return f.contribution === 0 ? t("ADX 低于 25，未计方向分", "ADX below 25; no directional points")
      : f.contribution > 0 ? t("ADX ≥ 25，+DI 占优", "ADX ≥ 25; +DI leads")
        : t("ADX ≥ 25，+DI 不占优", "ADX ≥ 25; +DI does not lead");
    case "macd_signal": return above ? t("MACD 高于信号线", "MACD above signal")
      : t("MACD 不高于信号线", "MACD at or below signal");
    case "macd_histogram": return above ? t("MACD 柱值为正", "MACD histogram positive")
      : t("MACD 柱值非正", "MACD histogram nonpositive");
    case "rsi": return f.contribution > 0 ? t("RSI 位于 50–70", "RSI between 50 and 70")
      : f.contribution === -5 ? t("RSI 低于 40", "RSI below 40")
        : f.contribution === -2 ? t("RSI 高于 80", "RSI above 80")
          : t("RSI 未触发加减分", "RSI adds no points");
    case "spy_63d": case "soxx_63d": {
      const name = f.key.split("_")[0].toUpperCase();
      return (above ? t("63 日收益高于", "63-session return above") : t("63 日收益不高于", "63-session return at or below")) + ` ${name}`;
    }
    case "up_down_volume": return above ? t("上涨日成交量占优", "Up-session volume leads")
      : t("上涨日成交量不占优", "Up-session volume does not lead");
    default: return f.key;
  }
}
