import type { ChartRecord } from "./chart-export";

export type ReadingTone = "up" | "down";
/** The series' own stroke, so a row matches its line without the legend. */
export type ReadingKey = { colour: string; dashed?: boolean; dotted?: boolean; kind?: "line" | "bar" | "area" };
export type ReadingItem = {
  label: string;
  value: string;
  tone?: ReadingTone;
  key?: ReadingKey;
  /** Same-tone relative figure after the value, e.g. "+9.62%". */
  detail?: string;
};
/** One chart position as the reader sees it: no source, basis or unit beside the figures. */
export type Reading = {
  /** Formatted for the reader's time zone and the range shown; never an ISO string. */
  time: string;
  /** One exception word, only when this point differs from the panel's usual basis. */
  flag?: string;
  /** The one figure the chart is about; single-series charts give it no label. */
  primary?: Omit<ReadingItem, "label"> & { label?: string };
  /** Supporting rows grouped by pane; groups are separated by space, not rules. */
  groups?: ReadingItem[][];
  /** Every row in full when the groups above summarise them: the live region, copy and export read these instead. */
  spoken?: ReadingItem[][];
  ohlc?: { close: string; change?: string; tone?: ReadingTone; open: string; high: string; low: string; volume?: string };
  /** Rows the reading leaves out. */
  more?: number;
};
/** A 6px dot drawn on a series at the selected position. */
export type ReadingMark = { value: number; colour: string; xAxisIndex?: number; yAxisIndex?: number };
/** Where a reading was asked for: the grid under the pointer or touch, absent for the keyboard. */
export type ReadingContext = { grid?: number };

/** Coordinates in the chart's first x axis, in ascending order. The value
 * reader uses these same coordinates; a drawn connector is never a point. */
export type ChartReadout = {
  positions: readonly number[];
  /** A chart with several panes may lead with the pane being read. */
  read: (position: number, context?: ReadingContext) => Reading | null;
  latest: string;
  /** Return no reading for a known missing interval, even near its ends. */
  gap?: (position: number) => boolean;
  observationCount?: number;
  gridIndexes?: readonly number[];
  records?: (position: number) => ChartRecord[];
  marks?: (position: number) => ReadingMark[];
};

export type ReadingLocale = "zh" | "en";
export type ReadingVariant = "card" | "strip";

const COPY = {
  zh: { open: "开", high: "高", low: "低", close: "收", volume: "量", more: (count: number) => "另 " + count + " 项" },
  en: { open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume", more: (count: number) => count + " more" },
} as const;

/** Secondary rows a card or phone strip shows before folding the rest into "N more". A strip
 * without a primary gives the primary's line to one more row, so it is never taller. */
export const READING_ROW_LIMIT = { card: 3, strip: 2 } as const;
/** Indicator cells beside a candle; the phone strip has room for the candle only. */
export const READING_CELL_LIMIT = { card: 4, strip: 0 } as const;

function documentLocale(): ReadingLocale {
  return typeof document !== "undefined" && document.documentElement.dataset.locale === "zh" ? "zh" : "en";
}

/** One element of the reading card. The React card and the HTML string are both built from it. */
export type ReadingNode = {
  tag: "div" | "span" | "dl" | "dt" | "dd" | "i";
  /** Attributes in render order; "style" carries one custom property. */
  attrs: Array<[name: string, value: string]>;
  children: Array<ReadingNode | string>;
};

const node = (tag: ReadingNode["tag"], attrs: ReadingNode["attrs"], ...children: Array<ReadingNode | string | false | undefined>): ReadingNode =>
  ({ tag, attrs, children: children.filter((child): child is ReadingNode | string => child !== false && child !== undefined && child !== "") });

// Series colours come from the chart palette; anything else could carry extra declarations.
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\)|var\(--[\w-]+\))$/i;

function key(swatch: ReadingKey | undefined) {
  if (!swatch) return undefined;
  const attrs: ReadingNode["attrs"] = [["class", "mx-reading-key"]];
  if (swatch.dashed) attrs.push(["data-dashed", ""]);
  if (swatch.dotted) attrs.push(["data-dotted", ""]);
  if (swatch.kind && swatch.kind !== "line") attrs.push(["data-kind", swatch.kind]);
  if (COLOUR.test(swatch.colour.trim())) attrs.push(["style", "--key:" + swatch.colour.trim()]);
  attrs.push(["aria-hidden", "true"]);
  return node("i", attrs);
}

function tone(value: ReadingTone | undefined): ReadingNode["attrs"] {
  return value ? [["data-tone", value]] : [];
}

function row(item: ReadingItem) {
  return node("div", [["class", "mx-reading-row"]],
    node("dt", [], key(item.key), item.label),
    node("dd", tone(item.tone), item.value, item.detail && node("span", [["class", "mx-reading-detail"]], item.detail)));
}

/** The reading card's structure, shared by ReadingCard and readingHtml so both render the same DOM. */
export function readingTree(reading: Reading, variant: ReadingVariant = "card", locale: ReadingLocale = documentLocale()): ReadingNode {
  const copy = COPY[locale];
  const ohlc = reading.ohlc;
  const primary = ohlc
    ? node("div", [["class", "mx-reading-primary"]],
      node("span", [["class", "mx-reading-label"]], copy.close),
      node("span", [["class", "mx-reading-value"]], ohlc.close),
      ohlc.change && node("span", [["class", "mx-reading-detail"], ...tone(ohlc.tone)], ohlc.change))
    : reading.primary && node("div", [["class", "mx-reading-primary"], ...tone(reading.primary.tone)],
      (reading.primary.label || reading.primary.key) && node("span", [["class", "mx-reading-label"]], key(reading.primary.key), reading.primary.label),
      node("span", [["class", "mx-reading-value"]], reading.primary.value),
      reading.primary.detail && node("span", [["class", "mx-reading-detail"]], reading.primary.detail));
  const limit = ohlc ? READING_CELL_LIMIT[variant]
    : READING_ROW_LIMIT[variant] + (variant === "strip" && !reading.primary ? 1 : 0);
  let room = limit;
  let hidden = reading.more ?? 0;
  const groups = (reading.groups ?? []).flatMap((group) => {
    const shown = group.slice(0, Math.max(0, room));
    room -= shown.length;
    hidden += group.length - shown.length;
    return shown.length
      ? [node("dl", [["class", "mx-reading-group"], ...(ohlc ? [["data-columns", "2"] as [string, string]] : [])], ...shown.map(row))]
      : [];
  });
  return node("div", [["class", "mx-reading"], ["data-variant", variant]],
    node("div", [["class", "mx-reading-head"]],
      node("span", [["class", "mx-reading-time"]], reading.time),
      reading.flag && node("span", [["class", "mx-reading-flag"]], reading.flag)),
    primary,
    ohlc && node("dl", [["class", "mx-reading-ohlc"]],
      row({ label: copy.open, value: ohlc.open }),
      row({ label: copy.high, value: ohlc.high }),
      row({ label: copy.low, value: ohlc.low }),
      ohlc.volume && row({ label: copy.volume, value: ohlc.volume })),
    ...groups,
    hidden > 0 && node("div", [["class", "mx-reading-more"]], copy.more(hidden)));
}

// The same escapes React applies to text and attribute values, so both renderings match byte for byte.
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

function html(item: ReadingNode | string): string {
  if (typeof item === "string") return escape(item);
  const attrs = item.attrs.map(([name, value]) => " " + name + '="' + escape(value) + '"').join("");
  return "<" + item.tag + attrs + ">" + item.children.map(html).join("") + "</" + item.tag + ">";
}

/** The reading card as HTML for ECharts tooltips: every provider string is escaped. */
export function readingHtml(reading: Reading, locale: ReadingLocale = documentLocale()): string {
  return html(readingTree(reading, "card", locale));
}

/** The reading as lines for the live region, "Copy reading" and PNG export: time, figures, then any exception word. */
export function readingText(reading: Reading, locale: ReadingLocale = documentLocale()): string {
  const copy = COPY[locale];
  const line = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ");
  const ohlc = reading.ohlc;
  return [
    reading.time,
    ...(ohlc ? [
      line(copy.close, ohlc.close, ohlc.change),
      line(copy.open, ohlc.open),
      line(copy.high, ohlc.high),
      line(copy.low, ohlc.low),
      ...(ohlc.volume ? [line(copy.volume, ohlc.volume)] : []),
    ] : reading.primary ? [line(reading.primary.label, reading.primary.value, reading.primary.detail)] : []),
    ...(reading.spoken ?? reading.groups ?? []).flat().map((item) => line(item.label, item.value, item.detail)),
    ...(reading.more ? [copy.more(reading.more)] : []),
    ...(reading.flag ? [reading.flag] : []),
  ].filter(Boolean).join("\n");
}

export function closestChartPosition(positions: readonly number[], target: number) {
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && (lo === positions.length || target - positions[lo - 1] < positions[lo] - target)) return lo - 1;
  return lo < positions.length ? lo : -1;
}

