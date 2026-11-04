"use client";

import Link from "./link";
import { useLocale, type Locale } from "@/components/locale-provider";
import type { DashboardLens } from "@/lib/types";
import type { Scope } from "@/lib/portfolio/nav";
import { tradingDay } from "@/lib/portfolio/history";
import { formatDate } from "@/ui/formatters";
import { currency, tone } from "@/workspace/data";
import { Tag, useCopy } from "./foundation";

type DayAttribution =
  | NonNullable<DashboardLens["dayAttribution"]>
  | NonNullable<DashboardLens["windowAttribution"]>;
type Driver = { ticker: string; name: string; amount: number };
/** 1D measures from today's opening; 5D chains the five trading days' openings. */
export type DriverSpan = "1D" | "5D";
export type Drivers = NonNullable<ReturnType<typeof dayDrivers>>;

/** Below this, the strip would describe rounding noise rather than a move. */
const MIN_EXPLAINED_GBP = 0.01;
/** One display bucket of slack when matching the opening to a chart point. */
const BUCKET_MS: Record<DriverSpan, number> = { "1D": 5 * 60_000, "5D": 30 * 60_000 };
/** One live sync: observations closer than this are the same one, at either end of the window. */
const SYNC_MS = 5 * 60_000;

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
 *
 * Drivers only explain the figure they sit under, so observations never mix. They
 * stay hidden while the figure stops at a cash-flow cutoff, and unless every scoped
 * account was measured on the figure's trading day, no earlier than one sync before
 * the chart's last point. A later observation of that trading day still counts, such
 * as a weekend one of Friday's: Other and Unattributed absorb what moved after it.
 *
 * Their window opens with the figure's when every scoped account opened within one
 * sync of its first point. An opening after that is stated, so the strip says what
 * it covers; one before it, or scoped accounts that opened at different times,
 * cannot explain the figure and hides the strip.
 */
export function dayDrivers({
  attribution,
  scope,
  day,
  dates,
  pnls,
  cutOff = false,
  limit = 3,
  span = "1D",
}: {
  attribution: DayAttribution;
  scope: Scope;
  /** The figure's trading day: the last day of its history. */
  day: string | undefined;
  /** The period chart's points and cumulative net P&L, oldest first. */
  dates: string[];
  pnls: Array<number | null>;
  /** The figure stops at the last verified cash flow while newer ones await reconciliation. */
  cutOff?: boolean;
  limit?: number;
  span?: DriverSpan;
}) {
  if (cutOff || !day || attribution.day !== day) return null;
  const codes = scope === "invest" ? ["A"] : scope === "isa" ? ["B"] : scope === "total" ? ["A", "B"] : [];
  const accounts = codes.map((code) => attribution.accounts?.[code as "A" | "B"]);
  if (!accounts.length || accounts.some((account) => !account)) return null;
  const last = Date.parse(dates.at(-1) ?? "");
  const measured = (asOf: string) => Date.parse(asOf) >= last - SYNC_MS && tradingDay(asOf) === day;
  if (accounts.some((account) => !measured(account!.asOf))) return null;
  const openings = accounts.map((account) => Date.parse(account!.since));
  const earliest = Math.min(...openings);
  const since = accounts[openings.indexOf(earliest)]!.since;
  const first = Date.parse(dates[0] ?? "");
  if (!(Math.max(...openings) - earliest <= SYNC_MS) || !(earliest >= first - SYNC_MS)) return null;
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
  if (!named.length && Math.abs(accountChange) < MIN_EXPLAINED_GBP) return null;
  // Positions explain little of a large move: cash, FX on cash, trades or timing.
  const material = Math.abs(unexplained) >= Math.max(5, Math.abs(accountChange) * 0.25);
  return {
    since,
    lateOpening: earliest > first + SYNC_MS ? since : null,
    accountChange,
    named,
    other: material ? explained - namedTotal : accountChange - namedTotal,
    unexplained,
    material,
  };
}

/** "08:10 起" / "since 08:10" for drivers that open after their figure; 5D adds the date. */
export function openingLabel(at: string, span: DriverSpan, locale: Locale, timeZone: string) {
  const time = formatDate(at, locale, span === "5D"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
    : { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return locale === "zh" ? `${time} 起` : `since ${time}`;
}

/** The strip for drivers that dayDrivers found; callers render nothing without them. */
export function DayDrivers({ drivers, span = "1D" }: { drivers: Drivers; span?: DriverSpan }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  return (
    <ul
      className="mx-day-drivers"
      aria-label={span === "5D" ? t("近 5 日变动来源", "What moved over five days") : t("今日变动来源", "What moved today")}
    >
      {drivers.lateOpening && (
        <li>
          <span>{openingLabel(drivers.lateOpening, span, locale, timeZone)}</span>
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

