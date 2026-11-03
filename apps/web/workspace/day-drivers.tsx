"use client";

import Link from "./link";
import { useLocale } from "@/components/locale-provider";
import type { DashboardLens } from "@/lib/types";
import type { Scope } from "@/lib/portfolio/nav";
import { formatDate } from "@/ui/formatters";
import { currency, tone } from "@/workspace/data";
import { Tag, useCopy } from "./foundation";

type DayAttribution =
  | NonNullable<DashboardLens["dayAttribution"]>
  | NonNullable<DashboardLens["windowAttribution"]>;
type Driver = { ticker: string; name: string; amount: number };
/** 1D measures from today's opening; 5D chains the five trading days' openings. */
export type DriverSpan = "1D" | "5D";

/** Below this, the strip would describe rounding noise rather than a move. */
const MIN_EXPLAINED_GBP = 0.01;
/** A later opening than the chart's first point is stated, since the parts then cover less. */
const LATE_OPENING_MS = 15 * 60_000;
/** One display bucket of slack when matching the opening to a chart point. */
const BUCKET_MS: Record<DriverSpan, number> = { "1D": 5 * 60_000, "5D": 30 * 60_000 };

/** Same precision as the period figure above, so the parts visibly add up to it. */
export function signedPounds(value: number) {
  const text = currency(value, "GBP", 2);
  return value >= 0.005 ? "+" + text : text;
}

/**
 * Splits the account's change since the trading day's first observation into the
 * largest position contributors and the rest, so the parts always add up to it.
 * When positions leave a large share unexplained, that share is reported on its
 * own instead of hiding inside "other".
 */
export function dayDrivers({
  attribution,
  scope,
  dates,
  pnls,
  limit = 3,
  span = "1D",
}: {
  attribution: DayAttribution;
  scope: Scope;
  /** The period chart's points and cumulative net P&L, oldest first. */
  dates: string[];
  pnls: Array<number | null>;
  limit?: number;
  span?: DriverSpan;
}) {
  const codes = scope === "invest" ? ["A"] : scope === "isa" ? ["B"] : scope === "total" ? ["A", "B"] : [];
  const accounts = codes.map((code) => attribution.accounts?.[code as "A" | "B"]);
  if (!accounts.length || accounts.some((account) => !account)) return null;
  const since = accounts.map((account) => account!.since).sort()[0];
  // Measure the account over the attribution's own window: from the first chart
  // point at its opening observation (one bucket of slack) to the latest point.
  const start = dates.findIndex((date) => Date.parse(date) >= Date.parse(since) - BUCKET_MS[span]);
  const opening = start >= 0 ? pnls[start] : null;
  const closing = pnls.at(-1);
  if (opening == null || closing == null) return null;
  const accountChange = closing - opening;
  const merged = new Map<string, Driver>();
  for (const account of accounts) {
    for (const row of account!.contributions ?? []) {
      const entry = merged.get(row.ticker) ?? { ticker: row.ticker, name: row.name, amount: 0 };
      entry.amount += row.contributionGbp;
      merged.set(row.ticker, entry);
    }
  }
  const positions = [...merged.values()];
  const explained = positions.reduce((total, row) => total + row.amount, 0);
  const named = positions
    .filter((row) => Math.abs(row.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
  const namedTotal = named.reduce((total, row) => total + row.amount, 0);
  const unexplained = accountChange - explained;
  // Positions explain little of a large move: cash, FX on cash, trades or timing.
  const material = Math.abs(unexplained) >= Math.max(5, Math.abs(accountChange) * 0.25);
  return {
    since,
    lateOpening: Date.parse(dates[start]) - Date.parse(dates[0]) > LATE_OPENING_MS ? dates[start] : null,
    accountChange,
    named,
    other: material ? explained - namedTotal : accountChange - namedTotal,
    unexplained,
    material,
  };
}

export function DayDrivers({
  attribution,
  scope,
  dates,
  pnls,
  span = "1D",
}: {
  attribution: DayAttribution;
  scope: Scope;
  dates: string[];
  pnls: Array<number | null>;
  span?: DriverSpan;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const drivers = dayDrivers({ attribution, scope, dates, pnls, span });
  if (!drivers || (!drivers.named.length && Math.abs(drivers.accountChange) < MIN_EXPLAINED_GBP)) return null;
  return (
    <ul
      className="mx-day-drivers"
      aria-label={span === "5D" ? t("近 5 日变动来源", "What moved over five days") : t("今日变动来源", "What moved today")}
    >
      {drivers.lateOpening && (
        <li>
          <span>
            {formatDate(drivers.lateOpening, locale, span === "5D"
              ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone }
              : { hour: "2-digit", minute: "2-digit", timeZone })}
            {t(" 起", " onwards")}
          </span>
        </li>
      )}
      {drivers.named.map((row) => (
        <li key={row.ticker}>
          <Link href={"/research?ticker=" + encodeURIComponent(row.ticker)} title={row.name}>
            {row.ticker}
          </Link>
          <span className={"mx-" + tone(row.amount)}>{signedPounds(row.amount)}</span>
        </li>
      ))}
      {Math.abs(drivers.other) >= 0.005 && (
        <li>
          <span>{t("其他", "Other")}</span>
          <span className={"mx-" + tone(drivers.other)}>{signedPounds(drivers.other)}</span>
        </li>
      )}
      {drivers.material && (
        <li
          title={t(
            "持仓价格变动之外的部分：现金、现金汇率、日内买卖或估值时点差异。",
            "Change outside position prices: cash, FX on cash, trades within a day or valuation timing.",
          )}
        >
          <Tag tone="warn">{t("未归因 ", "Unattributed ") + signedPounds(drivers.unexplained)}</Tag>
        </li>
      )}
    </ul>
  );
}

