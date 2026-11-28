import { currency } from "@/workspace/data";
import type { ReadingItem } from "./chart-readout";
import { pounds, readingTone, signedPercent, signedPounds } from "./reading-format";
import type { TimelineReading } from "./timeline-reading";

export const PERIOD_MONEY_LABELS: Readonly<Record<string, readonly [zh: string, en: string]>> = {
  period_pnl_gbp: ["本期净盈亏", "Period net P&L"],
  opening_value_gbp: ["期初市值", "Opening value"],
  ending_value_gbp: ["期末市值", "Closing value"],
  net_contributions_gbp: ["净流入", "Net contributions"],
  max_money_drawdown_gbp: ["最大金额回撤", "Maximum money drawdown"],
};

const gbp = (value: number) => currency(value, "GBP", 2);
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2, useGrouping: false });
const pence = (value: number) => Math.round(Number(decimal.format(value)) * 100);

function moneyTerm(value: number) {
  return { operator: value <= -0.005 ? "−" : "+", amount: gbp(Math.abs(value)) };
}

export function signedPnl(value: number | null) {
  if (value == null) return { amount: "—", tone: undefined };
  const { operator, amount } = moneyTerm(value);
  if (Math.abs(value) < 0.005) return { amount, tone: undefined };
  return { amount: operator + amount, tone: operator === "−" ? "down" as const : "up" as const };
}

export function moneyEquation({ opening, ending, contributions, pnl }: {
  opening: number | null;
  ending: number | null;
  contributions: number | null;
  pnl: number | null;
}) {
  if (opening == null || ending == null || contributions == null || pnl == null) return null;
  // Reconcile the underlying figures; a separately rounded penny can make
  // the displayed amounts approximate.
  return {
    opening: gbp(opening),
    contributions: moneyTerm(contributions),
    pnl: moneyTerm(pnl),
    operator: pence(opening) + pence(contributions) + pence(pnl) === pence(ending) ? "=" : "≈",
    ending: gbp(ending),
  };
}

type Values = Array<number | null | undefined>;

/**
 * The money page's reading: period net P&L leads with its share of the opening value; the
 * P&L drawdown follows when there is one, then account value and cumulative net deposits,
 * each keyed to its stroke. Constants (the opening value) and zero flows stay out.
 */
export function moneyTimelineReading({ pnls, pnlPercents, drawdowns, drawdownPercents, flows, valueLines, percentage, valueLayer, t }: {
  pnls: Values;
  pnlPercents: Values;
  drawdowns: Values;
  drawdownPercents: Values;
  /** Net deposits within the period up to each row. */
  flows: Values;
  valueLines: Array<{ name: string; values: Values }>;
  /** Figures relative to the opening value instead of pounds. */
  percentage: boolean;
  valueLayer: number;
  t: (zh: string, en: string) => string;
}): TimelineReading {
  return (row, { key }) => {
    const pnl = pnls[row], pnlPercent = pnlPercents[row];
    const decline = drawdowns[row], declinePercent = drawdownPercents[row];
    const flow = flows[row];
    const drawdown: ReadingItem[] = readingTone(decline) ? [{
      label: t("盈亏回撤", "P&L drawdown"),
      value: percentage ? signedPercent(declinePercent) : signedPounds(decline),
      tone: "down",
      ...(percentage ? { detail: signedPounds(decline) } : declinePercent != null ? { detail: signedPercent(declinePercent) } : {}),
    }] : [];
    const moved = signedPounds(flow, 0);
    const values = valueLines.flatMap((line, index): ReadingItem[] => line.values[row] == null ? [] : [{
      label: line.name,
      key: key(valueLayer, index),
      value: percentage ? signedPercent(line.values[row]) : pounds(line.values[row], 0),
      // Net deposits within the period appear only when money moved.
      ...(index === 1 && !percentage && readingTone(flow) ? { detail: t("区间", "Period") + " " + moved } : {}),
    }]);
    const groups = [drawdown, values].filter((group) => group.length);
    return {
      primary: {
        label: t("区间净盈亏", "Period net P&L"),
        value: percentage ? signedPercent(pnlPercent) : signedPounds(pnl),
        tone: readingTone(percentage ? (pnlPercent ?? 0) * 100 : pnl),
        ...(percentage ? { detail: signedPounds(pnl) } : pnlPercent != null ? { detail: signedPercent(pnlPercent) + t(" 相对期初", " vs opening") } : {}),
      },
      ...(groups.length ? { groups } : {}),
    };
  };
}
