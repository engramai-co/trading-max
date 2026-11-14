"use client";

import { Button, Menu, Tooltip, useComputedColorScheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode,
} from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoardResponse, SectorGroup, SectorMarketCode } from "@/lib/types";
import { formatCalendarDate, formatDate, formatDateTime, formatDeltaPercent } from "@/ui/formatters";
import { CenteredCopy } from "@/ui/centered-copy";
import { useFinePointer } from "@/ui/pointer";
import { api, percent, tone } from "@/workspace/data";
import { Empty, Panel, Pending, Tag, UpdateFailure, useCopy } from "./foundation";
import { globalMarketReading, useGlobalContribution, type GlobalMarketContribution } from "./global-markets-data";
import Link from "./link";
import { InlineRetry } from "./dashboard-controls";
import { SectorSources, SessionClock, useMinute, usePhaseNames } from "./sectors-clock";
import { SECTOR_MARKETS, heatMix, marketPhase, sectorMarket, squarify, type Tile } from "./sectors-data";
import { changeTone, groupName, textWidth } from "./sectors-map";

/** Seam between blocks. */
const GAP = 3;

/**
 * A tile as a block in whole pixels. The frame is one gap wider and taller than the map and each block gives up one
 * gap, so seams are one gap wide and the outer blocks meet the frame.
 */
function box(tile: Tile): Tile {
  const x = Math.round(tile.x);
  const y = Math.round(tile.y);
  return { key: tile.key, x, y, w: Math.max(0, Math.round(tile.x + tile.w) - x - GAP), h: Math.max(0, Math.round(tile.y + tile.h) - y - GAP) };
}
/** A block's padding, type size and line height, as the stylesheet sets them; small blocks set tighter. */
const ROOMY = { padX: 10, padY: 8, size: 13, line: 18 };
const COMPACT = { padX: 6, padY: 5, size: 12, line: 16 };
/** The last setting before a narrow block gives up its move: the smallest type, on the narrowest padding. */
const TIGHT = { padX: 3, padY: 5, size: 12, line: 16 };
type Type = typeof ROOMY;

/** Brokers' short sector names, for blocks too small for the full one; the full name stays in the label. */
const SHORT: Record<string, [string, string]> = {
  "10": ["能源", "Energy"],
  "15": ["材料", "Materials"],
  "20": ["工业", "Industrials"],
  "25": ["可选消费", "Discretionary"],
  "30": ["必需消费", "Staples"],
  "35": ["医疗", "Health"],
  "40": ["金融", "Financials"],
  "45": ["科技", "Tech"],
  "50": ["通信", "Comms"],
  "55": ["公用", "Utilities"],
  "60": ["地产", "Real estate"],
};
/** English abbreviations for the smallest blocks; the Chinese short names already fit. */
const TINY: Record<string, string> = { "15": "Matl.", "55": "Util.", "60": "R. est." };
/**
 * Proportions the map is laid out at before it is scaled to its own. Each keeps every area true to its weight but
 * closes the rows elsewhere, so the smallest sectors land in different shapes; the standard layout comes first.
 */
const ASPECTS = [1, 0.9, 1.1, 0.8, 1.25, 0.7, 1.4, 0.65, 1.5, 0.6, 1.6, 0.55, 1.8];
/** Moves the layout is chosen for, so a quote refresh never moves a block: the figures shown fit the chosen shapes. */
const SAMPLE_MOVE = { full: "+0.00%", rounded: "+0.0%" };

type Measure = (text: string, size: number) => number;
type Shown = {
  name: string;
  change: string;
  showName: boolean;
  showChange: boolean;
  wrap: boolean;
  inline: boolean;
  compact: boolean;
  tight: boolean;
  /** The full name and the two-decimal move are both on the block. */
  complete: boolean;
};

let canvas: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Rendered width of a semibold label in the page's own font; the estimate stands in without a canvas. */
function measureText(text: string, size: number, family: string) {
  if (canvas === undefined) canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!canvas || !family) return textWidth(text, size);
  const key = family + "|" + size + "|" + text;
  let width = widths.get(key);
  if (width == null) {
    canvas.font = "600 " + size + "px " + family;
    width = canvas.measureText(text).width;
    widths.set(key, width);
  }
  return width;
}

/** Lines a name needs at a width: Latin names break between words; Chinese names stay on one line. */
function lineCount(name: string, room: number, size: number, measure: Measure) {
  if (measure(name, size) <= room) return 1;
  const words = name.split(" ");
  if (words.length < 2) return Infinity;
  const space = measure(" ", size);
  let lines = 1;
  let line = 0;
  for (const word of words) {
    const width = measure(word, size);
    if (width > room) return Infinity;
    if (line === 0) line = width;
    else if (line + space + width <= room) line += space + width;
    else {
      lines += 1;
      line = width;
    }
  }
  return lines;
}

/**
 * What a block shows. Its name over its whole move, trying the full name, then tighter type, then the short
 * name, then the move to one decimal; then both on one line for a wide, short block; then two lines of name;
 * then the narrowest padding; then the name alone, since the wash already shows the direction. Whatever a block
 * leaves out, its tooltip and accessible name carry.
 */
function labels(names: { full: string; short: string; tiny: string }, change: string, rounded: string, width: number, height: number,
  measure: Measure): Shown {
  const { full, short, tiny } = names;
  const attempt = ({ name, change: move, type }: { name: string; change: string; type: Type }) => {
    const room = width - type.padX * 2;
    const rows = Math.floor((height - type.padY * 2) / type.line);
    const lines = lineCount(name, room, type.size, measure);
    const moveWidth = measure(move, type.size);
    return {
      name,
      move,
      compact: type !== ROOMY,
      tight: type === TIGHT,
      rows,
      oneLine: lines === 1,
      twoLines: lines <= 2,
      fits: moveWidth <= room,
      inline: lines === 1 && measure(name, type.size) + 6 + moveWidth <= room,
    };
  };
  const attempts = [
    { name: full, change, type: ROOMY },
    { name: full, change, type: COMPACT },
    { name: short, change, type: ROOMY },
    { name: short, change, type: COMPACT },
    { name: short, change: rounded, type: COMPACT },
    { name: tiny, change: rounded, type: COMPACT },
  ].map(attempt);
  const pick = (chosen: ReturnType<typeof attempt>, shown: Partial<Shown>): Shown => {
    const result = {
      name: chosen.name, change: chosen.move, compact: chosen.compact, tight: chosen.tight,
      showName: true, showChange: true, wrap: false, inline: false, ...shown,
    };
    return { ...result, complete: result.showName && result.showChange && result.name === full && result.change === change };
  };
  const stacked = attempts.find((a) => a.oneLine && a.fits && a.rows >= 2);
  if (stacked) return pick(stacked, {});
  const inline = attempts.find((a) => a.inline && a.rows >= 1);
  if (inline) return pick(inline, { inline: true });
  const wrapped = attempts.find((a) => a.twoLines && a.fits && a.rows >= 3);
  if (wrapped) return pick(wrapped, { wrap: true });
  const tight = attempt({ name: tiny, change: rounded, type: TIGHT });
  if (tight.oneLine && tight.fits && tight.rows >= 2) return pick(tight, {});
  const named = attempts.find((a) => a.oneLine && a.rows >= 1) ?? attempts.find((a) => a.twoLines && a.rows >= 2);
  if (named) return pick(named, { showChange: false, wrap: !named.oneLine });
  return pick(attempts[0], { showName: false, showChange: false });
}

type OverviewMarket = SectorMarketCode | "global";
type WorldMarket = GlobalMarketContribution["markets"][number]["market"];

const MARKET_NAMES: Record<string, [string, string]> = {
  global: ["全球", "Global"],
  us: ["美股", "US"],
  eu: ["欧洲", "Europe"],
  uk: ["英股", "UK"],
  hk: ["港股", "Hong Kong"],
  kr: ["韩股", "Korea"],
  jp: ["日股", "Japan"],
  tw: ["台股", "Taiwan"],
  in: ["印股", "India"],
  ca: ["加股", "Canada"],
  au: ["澳股", "Australia"],
};

/** The reader's market for this card, kept in the browser; the US until they choose another. */
const MARKET_KEY = "mx-overview-market";
const marketListeners = new Set<() => void>();
// A choice the browser would not store still holds for the session.
let unsaved: string | null = null;
function subscribeMarket(listener: () => void) {
  marketListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    marketListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readMarket() {
  try {
    return window.localStorage.getItem(MARKET_KEY) ?? unsaved;
  } catch {
    return unsaved;
  }
}
function chooseMarket(value: OverviewMarket) {
  unsaved = value;
  try {
    window.localStorage.setItem(MARKET_KEY, value);
  } catch {
    // Private windows keep the choice until the tab closes.
  }
  for (const listener of marketListeners) listener();
}
/** Null until the browser has been read, so the first request is already the chosen market's. */
function useOverviewMarket() {
  const stored = useSyncExternalStore<string | null | undefined>(subscribeMarket, readMarket, () => undefined);
  const market: OverviewMarket | null = stored === undefined ? null
    : stored === "global" ? "global" : sectorMarket(stored) ?? "us";
  return [market, chooseMarket] as const;
}

/**
 * Today's sectors on the overview, the US unless the reader picks another market: one flat block per GICS sector,
 * area by index weight and a wash by the session's move. The board is the Markets page's own answer, so opening a
 * block reuses it. Global shows the markets themselves as a block world map.
 */
function useOverviewSectors(market: SectorMarketCode | null) {
  return useQuery({
    queryKey: ["workspace-sectors", market],
    queryFn: ({ signal }) => api<SectorBoardResponse>("/sectors?market=" + market, { signal }),
    enabled: market !== null,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function OverviewSectors() {
  const t = useCopy();
  const [market, choose] = useOverviewMarket();
  const name = (value: string) => {
    const names = MARKET_NAMES[value];
    return names ? t(names[0], names[1]) : value.toUpperCase();
  };
  const title = market === "global" ? t("全球市场", "Global markets")
    : market ? name(market) + t("板块", " sectors") : t("板块", "Sectors");
  const picker = (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <button type="button" className="mx-overview-market" aria-label={t("选择市场，当前：", "Choose market, now: ") + title}>
          {title}
          <CaretDown size={14} aria-hidden="true" />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        {(["global", ...SECTOR_MARKETS] as OverviewMarket[]).map((value) => (
          <Menu.Item key={value} aria-current={value === market ? "true" : undefined} onClick={() => choose(value)}>
            {name(value)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
  if (market === null) return (
    <Panel className="mx-overview-sectors" title={picker}>
      <Pending shape="sectors" quiet />
    </Panel>
  );
  return market === "global"
    ? <GlobalPanel title={title} picker={picker} />
    : <SectorPanel market={market} title={title} picker={picker} />;
}

function SectorPanel({ market, title, picker }: { market: SectorMarketCode; title: string; picker: ReactNode }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const now = useMinute();
  const phaseName = usePhaseNames();
  const query = useOverviewSectors(market);
  const data = query.data;
  const board = data?.board?.market === market ? data.board : null;
  // An answer missing its parts shows the empty board rather than breaking the overview.
  const status = data?.markets?.find((item) => item.market === market);
  const groups = board?.groupings?.find((grouping) => grouping.kind === "gics")?.groups ?? [];
  const clock = status && board && (
    <SessionClock status={status} board={board} phase={marketPhase(status.sessions, status.timezone, now).phase}
      phaseName={phaseName} monitorOn={data?.monitor?.enabled !== false} refreshFailed={false} now={now} sources={false} />
  );
  return (
    <Panel
      className="mx-overview-sectors"
      title={picker}
      helpLabel={title}
      help={board ? <SectorSources source={board.source} /> : undefined}
      action={<span className="mx-freshness-group">{clock}{query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}</span>}
    >
      {query.isPending ? (
        <Pending shape="sectors" label={t("正在读取", "Loading ") + title + t("…", "…")} />
      ) : !board && query.isError ? (
        <div className="mx-overview-unavailable"><InlineRetry label={t("板块行情暂不可用", "Sector quotes unavailable")} retry={query.refetch} /></div>
      ) : !board || !groups.length ? (
        <Empty
          title={t("还没有板块数据", "No sector data yet")}
          description={data?.monitor?.enabled === false
            ? <span className="mx-sector-empty-copy">
                <CenteredCopy>{t("开启「证券研究与每日对账」", "Enable Research & daily reconciliation")}</CenteredCopy>
                <wbr />
                <CenteredCopy>{t("即可在交易时段刷新板块。", " to refresh sectors during market hours.")}</CenteredCopy>
              </span>
            : data?.monitor?.nextRunAt
              ? t("下一次更新 ", "Next update ") + formatDateTime(data.monitor.nextRunAt, locale, timeZone)
              : undefined}
          action={data?.monitor?.enabled === false
            ? <Button component={Link} href="/settings" variant="default">{t("打开设置", "Open settings")}</Button>
            : undefined}
        />
      ) : (
        <SectorBoard groups={groups} market={market} label={title} />
      )}
    </Panel>
  );
}

/**
 * The global card: one block per market, washed by its main index's move today. With dated ACWI weights a mouse gets
 * the markets as a map by their share of the world index, the rest of the world as one neutral block, like the sector
 * map; phones and touch get equal blocks by share. Without weights the blocks sit roughly where each market lies.
 */
const WORLD: Record<WorldMarket, { at: [number, number]; name: [string, string]; short: string }> = {
  ca: { at: [1, 1], name: ["加拿大", "Canada"], short: "CA" },
  us: { at: [1, 2], name: ["美国", "US"], short: "US" },
  uk: { at: [3, 1], name: ["英国", "UK"], short: "UK" },
  eu: { at: [4, 1], name: ["欧洲", "Europe"], short: "EU" },
  ch: { at: [4, 2], name: ["瑞士", "Switzerland"], short: "CH" },
  cn: { at: [5, 1], name: ["中国", "China"], short: "CN" },
  in: { at: [5, 2], name: ["印度", "India"], short: "IN" },
  kr: { at: [6, 1], name: ["韩国", "Korea"], short: "KR" },
  jp: { at: [7, 1], name: ["日本", "Japan"], short: "JP" },
  hk: { at: [6, 2], name: ["香港", "Hong Kong"], short: "HK" },
  tw: { at: [7, 2], name: ["台湾", "Taiwan"], short: "TW" },
  au: { at: [7, 3], name: ["澳洲", "Australia"], short: "AU" },
};
/** Phones list the same blocks in reading order, west to east. */
const WORLD_ORDER: WorldMarket[] = ["us", "ca", "uk", "eu", "ch", "cn", "in", "jp", "kr", "hk", "tw", "au"];
type WorldMove = GlobalMarketContribution["markets"][number];
type WorldKey = WorldMarket | "other";

function GlobalPanel({ title, picker }: { title: string; picker: ReactNode }) {
  const t = useCopy();
  const fine = useFinePointer();
  const phone = useMediaQuery("(max-width: 767px)") ?? false;
  const query = useGlobalContribution(true);
  const answer = query.data;
  const markets = (answer?.markets ?? []).filter((item) => item.market in WORLD);
  const weighted = markets.some((item) => (item.weight ?? 0) > 0);
  // The map leaves no ocean corner, so the world index moves to the heading beside the clock.
  const mapped = Boolean(fine && !phone && weighted);
  return (
    <Panel
      className="mx-overview-sectors"
      title={picker}
      helpLabel={title}
      help={<p>{weighted ? t(
        "面积是各市场在 MSCI 全球指数中的占比，按 iShares MSCI ACWI 的持仓计算；颜色是该市场主要股指的当日涨跌，越深涨跌越大。点开一块查看该市场。",
        "Area is each market’s share of MSCI ACWI, from iShares MSCI ACWI holdings; colour is the day’s move in its main index, deeper for a bigger move. Open a block for that market.",
      ) : t(
        "每块是该市场主要股指的当日涨跌，颜色越深，涨跌越大。点开一块查看该市场。",
        "Each block is the day’s move in that market’s main index; deeper colour means a bigger move. Open a block for that market.",
      )}</p>}
      action={<span className="mx-freshness-group">
        {answer && mapped && <AcwiTotal move={answer.acwiMove} />}
        {answer && <GlobalStamp answer={answer} />}
        {query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}</span>}
    >
      {query.isPending ? (
        <Pending shape="sectors" label={t("正在读取全球市场…", "Loading global markets…")} />
      ) : !answer && query.isError ? (
        <div className="mx-overview-unavailable"><InlineRetry label={t("全球行情暂不可用", "Global quotes unavailable")} retry={query.refetch} /></div>
      ) : !answer || !markets.length ? (
        <Empty title={t("还没有全球行情", "No global quotes yet")} />
      ) : (
        <>
          {mapped && <WorldMap markets={markets} other={answer.otherWeight ?? 0} label={title + t("地图", " map")} />}
          <WorldBlocks markets={markets} acwiMove={answer.acwiMove} label={title} weighted={weighted} />
        </>
      )}
    </Panel>
  );
}

function AcwiTotal({ move }: { move: number | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  return (
    <Link href="/sectors" className="mx-overview-acwi">
      {t("MSCI 全球", "MSCI ACWI")}
      <strong className={move == null ? undefined : "mx-" + tone(move)}>{formatDeltaPercent(move, locale, 2)}</strong>
    </Link>
  );
}

function GlobalStamp({ answer }: { answer: GlobalMarketContribution }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const stamp = answer.asOf;
  if (!stamp) return null;
  // Kept quotes from before a restart or a provider limit carry their own time, said plainly.
  if (answer.pricesStale) return (
    <Tag tone="warn">{t("报价未更新 · ", "Quotes haven’t updated · ") + formatDateTime(stamp, locale, timeZone)}</Tag>
  );
  const phase = answer.phase === "completed" ? t("已收盘", "Closed") : answer.phase === "live" ? t("盘中", "Open") : null;
  const time = formatDate(stamp, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  // A finished day is named by its MSCI date; the publication clock belongs to the next day in Europe and Asia.
  const closedDay = answer.phase === "completed" ? answer.referenceDate : null;
  return (
    <div className="mx-sectors-clock">
      {phase && <span>{phase}</span>}
      <span>{closedDay
        ? <time dateTime={closedDay}>{formatCalendarDate(closedDay, locale)}</time>
        : <time dateTime={stamp}>{t("截至 ", "As of ")}{answer.phase === "live" ? time : formatDateTime(stamp, locale, timeZone)}</time>}</span>
    </div>
  );
}

/** A market's move as its block shows it: closed markets say so, a missing reading is a dash. */
function worldChange(item: Pick<WorldMove, "move" | "notOpen">, locale: Parameters<typeof formatDeltaPercent>[1], digits: number,
  t: (zh: string, en: string) => string) {
  if (item.notOpen) return t("未开盘", "Not open");
  return item.move == null ? "—" : formatDeltaPercent(item.move, locale, digits);
}

function WorldBlocks({ markets, acwiMove, label, weighted }: {
  markets: WorldMove[]; acwiMove: number | null; label: string; weighted: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("light");
  const total = formatDeltaPercent(acwiMove, locale, 2);
  // With weights, phones read the blocks by share, the largest first.
  const order = weighted
    ? [...markets].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || WORLD_ORDER.indexOf(a.market) - WORLD_ORDER.indexOf(b.market))
      .map((item) => item.market)
    : WORLD_ORDER;
  return (
    <div className="mx-overview-world" role="group" aria-label={label} data-weighted={weighted ? "" : undefined}>
      {markets.map((item) => {
        const { market, move, notOpen } = item;
        const place = WORLD[market];
        const full = t(place.name[0], place.name[1]);
        const idle = notOpen || move == null;
        const change = worldChange(item, locale, 2, t);
        const reading = globalMarketReading(market, full, locale) + " " + change;
        const style = {
          "--mx-heat-mix": heatMix(notOpen ? null : move, scheme),
          "--mx-world-column": place.at[0],
          "--mx-world-row": place.at[1],
          order: order.indexOf(market),
        } as CSSProperties;
        return (
          <Link key={market} href={"/sectors?market=" + market} className="mx-overview-sector" style={style}
            data-tone={idle ? undefined : changeTone(move)} data-idle={idle ? "" : undefined}
            aria-label={reading} title={market === "cn" ? reading : undefined}>
            <span className="mx-overview-sector-name">{locale === "zh" ? full : place.short}</span>
            {/* A narrow card rounds to one decimal; the accessible name keeps both. */}
            <span className="mx-overview-sector-change">
              {idle ? change : <>
                <span className="mx-overview-world-full">{change}</span>
                <span className="mx-overview-world-short">{formatDeltaPercent(move, locale, 1)}</span>
              </>}
            </span>
          </Link>
        );
      })}
      <Link href="/sectors" className="mx-overview-world-total" aria-label={t("MSCI 全球 ", "MSCI ACWI ") + total}>
        <span>{t("MSCI 全球", "MSCI ACWI")}</span>
        <strong className={acwiMove == null ? undefined : "mx-" + tone(acwiMove)}>{total}</strong>
      </Link>
    </div>
  );
}

/**
 * The markets by their share of MSCI ACWI, laid out like the sector map: small blocks finish their labels on hover,
 * and the rest of the world closes the map as one neutral block.
 */
function WorldMap({ markets, other, label }: { markets: WorldMove[]; other: number; label: string }) {
  const t = useCopy();
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("light");
  const map = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [family, setFamily] = useState("");
  const measure = useCallback<Measure>((text, size) => measureText(text, size, family), [family]);
  useLayoutEffect(() => {
    const element = map.current;
    if (!element) return;
    setFamily(getComputedStyle(element).fontFamily);
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current && Math.abs(current.w - width) < 1 && Math.abs(current.h - height) < 1 ? current : { w: width, h: height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const names = useCallback((key: WorldKey) => {
    if (key === "other") {
      const name = locale === "zh" ? "其他" : "Other";
      return { full: name, short: name, tiny: name };
    }
    const place = WORLD[key];
    const full = locale === "zh" ? place.name[0] : place.name[1];
    const short = locale === "zh" ? full : place.short;
    return { full, short, tiny: short };
  }, [locale]);
  const items = useMemo(() => [
    ...markets.map((item) => ({ key: item.market as WorldKey, weight: item.weight ?? 0 })),
    { key: "other" as WorldKey, weight: other },
  ], [markets, other]);
  const weights = items.map((item) => item.key + ":" + item.weight.toFixed(5)).join(",");
  // The layout whose blocks keep the most of their labels, as the sector map chooses its own.
  const tiles = useMemo(() => {
    if (!size) return [];
    let best: { tiles: Tile<WorldKey>[]; lost: number } | null = null;
    for (const aspect of ASPECTS) {
      const laid = squarify(items, { x: 0, y: 0, w: size.w + GAP, h: (size.h + GAP) * aspect })
        .map((tile) => box({ ...tile, y: tile.y / aspect, h: tile.h / aspect }) as Tile<WorldKey>);
      const lost = laid.reduce((sum, tile) => {
        const shown = labels(names(tile.key), SAMPLE_MOVE.full, SAMPLE_MOVE.rounded, tile.w, tile.h, measure);
        return sum + (shown.showName ? 0 : 2) + (tile.key === "other" || shown.showChange ? 0 : 1);
      }, 0);
      if (!best || lost < best.lost) best = { tiles: laid, lost };
      if (lost === 0) break;
    }
    return best?.tiles ?? [];
    // The weights string stands for the items: a refresh that only changes moves keeps the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights, size, measure, names]);
  const byMarket = new Map(markets.map((item) => [item.market as WorldKey, item]));
  return (
    <div ref={map} className="mx-overview-sector-map mx-overview-world-map" role="group" aria-label={label}>
      {tiles.map(({ key, x: left, y: top, w: width, h: height }) => {
        const item = byMarket.get(key);
        const share = key === "other" ? other : item?.weight ?? 0;
        const idle = !item || item.notOpen || item.move == null;
        const change = item ? worldChange(item, locale, 2, t) : "";
        const shown = labels(names(key), change, item ? worldChange(item, locale, 1, t) : "", width, height, measure);
        const name = key === "other" ? t("其他市场", "Other markets") : names(key).full;
        const reading = [globalMarketReading(key, name, locale), change].filter(Boolean).join(" ");
        const spoken = locale === "zh"
          ? `${reading}，占比 ${percent(share, false, 1)}`
          : `${reading}, ${percent(share, false, 1)} of ACWI`;
        const style = { left, top, width, height, "--mx-heat-mix": heatMix(idle ? null : item!.move, scheme) } as CSSProperties;
        return (
          <Tooltip key={key} label={spoken} events={{ hover: true, focus: true, touch: false }} openDelay={120} withinPortal>
            <Link href={key === "other" ? "/sectors" : "/sectors?market=" + key} className="mx-overview-sector"
              data-tone={idle ? undefined : changeTone(item!.move)} data-idle={idle ? "" : undefined}
              data-compact={shown.compact ? "" : undefined} data-tight={shown.tight ? "" : undefined}
              data-inline={shown.inline ? "" : undefined} style={style} aria-label={spoken}>
              {shown.showName && <span className="mx-overview-sector-name" data-wrap={shown.wrap ? "" : undefined}>{shown.name}</span>}
              {key !== "other" && shown.showChange && <span className="mx-overview-sector-change">{shown.change}</span>}
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * A mouse gets the weighted map, whose small blocks finish their labels on hover. Phones and touch get one equal
 * block per sector instead, each large enough to tap and to carry its whole move. Stylesheets choose between them
 * too, so neither shows before the pointer is known.
 */
function SectorBoard({ groups, market, label }: { groups: SectorGroup[]; market: SectorMarketCode; label: string }) {
  const t = useCopy();
  const fine = useFinePointer();
  const phone = useMediaQuery("(max-width: 767px)") ?? false;
  return (
    <>
      {fine && !phone && <SectorMap groups={groups} market={market} label={label + t("地图", " map")} />}
      <SectorGrid groups={groups} market={market} label={label} />
    </>
  );
}

/** The accessible name of a sector block: its full name and two-decimal move, whatever the block shows. */
function useSpoken() {
  const { locale } = useLocale();
  return (group: SectorGroup) => groupName(group, "gics", locale) + " " + formatDeltaPercent(group.change, locale, 2);
}

function SectorMap({ groups, market, label }: { groups: SectorGroup[]; market: SectorMarketCode; label: string }) {
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("light");
  const spoken = useSpoken();
  const map = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [family, setFamily] = useState("");
  const measure = useCallback<Measure>((text, size) => measureText(text, size, family), [family]);
  useLayoutEffect(() => {
    const element = map.current;
    if (!element) return;
    setFamily(getComputedStyle(element).fontFamily);
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current && Math.abs(current.w - width) < 1 && Math.abs(current.h - height) < 1 ? current : { w: width, h: height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Each sector's names. The layout depends on these, the weights and the size only.
  const names = useCallback((group: SectorGroup) => {
    const full = groupName(group, "gics", locale);
    const short = SHORT[group.key]?.[locale === "zh" ? 0 : 1] ?? full;
    return { full, short, tiny: (locale === "en" && TINY[group.key]) || short };
  }, [locale]);
  const weights = groups.map((group) => group.key + ":" + group.weight).join(",");
  // The layout whose blocks keep the most of their labels: a lost name counts double a lost move.
  const tiles = useMemo(() => {
    if (!size) return [];
    const items = groups.map((group) => ({ key: group.key, weight: group.weight }));
    const byKey = new Map(groups.map((group) => [group.key, group]));
    let best: { tiles: Tile[]; lost: number } | null = null;
    for (const aspect of ASPECTS) {
      const laid = squarify(items, { x: 0, y: 0, w: size.w + GAP, h: (size.h + GAP) * aspect })
        .map((tile) => box({ ...tile, y: tile.y / aspect, h: tile.h / aspect }));
      const lost = laid.reduce((sum, tile) => {
        const shown = labels(names(byKey.get(tile.key)!), SAMPLE_MOVE.full, SAMPLE_MOVE.rounded, tile.w, tile.h, measure);
        return sum + (shown.showName ? 0 : 2) + (shown.showChange ? 0 : 1);
      }, 0);
      if (!best || lost < best.lost) best = { tiles: laid, lost };
      if (lost === 0) break;
    }
    return best?.tiles ?? [];
    // The weights string stands for the groups: a refresh that only changes moves keeps the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights, size, measure, names]);
  const byKey = new Map(groups.map((group) => [group.key, group]));
  return (
    <div ref={map} className="mx-overview-sector-map" role="group" aria-label={label}>
      {tiles.map(({ key, x: left, y: top, w: width, h: height }) => {
        const group = byKey.get(key);
        if (!group) return null;
        const shown = labels(names(group), formatDeltaPercent(group.change, locale, 2), formatDeltaPercent(group.change, locale, 1),
          width, height, measure);
        const style = { left, top, width, height, "--mx-heat-mix": heatMix(group.change, scheme) } as CSSProperties;
        const content = (
          <>
            {shown.showName && <span className="mx-overview-sector-name" data-wrap={shown.wrap ? "" : undefined}>{shown.name}</span>}
            {shown.showChange && <span className="mx-overview-sector-change">{shown.change}</span>}
          </>
        );
        const attributes = {
          className: "mx-overview-sector",
          "data-tone": changeTone(group.change),
          "data-compact": shown.compact ? "" : undefined,
          "data-tight": shown.tight ? "" : undefined,
          "data-inline": shown.inline ? "" : undefined,
          style,
        };
        // A block that leaves part of its label out shows all of it on hover and on keyboard focus. The tooltip stays
        // mounted, only disabled, so a refresh that changes what fits keeps the link and its focus.
        return (
          <Tooltip key={group.key} label={spoken(group)} events={{ hover: true, focus: true, touch: false }} openDelay={120}
            withinPortal disabled={shown.complete}>
            <Link href={"/sectors?market=" + market + "&sector=" + encodeURIComponent(group.key)} {...attributes} aria-label={spoken(group)}>
              {content}
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Phones and touch: blocks in index-weight order, each opening its sector, with the full name where it fits. */
function SectorGrid({ groups, market, label }: { groups: SectorGroup[]; market: SectorMarketCode; label: string }) {
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("light");
  const spoken = useSpoken();
  const grid = useRef<HTMLDivElement>(null);
  // The width a label has: the first block's own, which may be a double block, and every other block's.
  const [room, setRoom] = useState<{ first: number; other: number } | null>(null);
  const [family, setFamily] = useState("");
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    setFamily(getComputedStyle(element).fontFamily);
    const measure = () => {
      const width = (block: Element | null) => (block ? block.getBoundingClientRect().width - ROOMY.padX * 2 : 0);
      const next = { first: width(element.firstElementChild), other: width(element.lastElementChild) };
      setRoom((current) =>
        current && Math.abs(current.first - next.first) < 1 && Math.abs(current.other - next.other) < 1 ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const ordered = useMemo(() => [...groups].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key)), [groups]);
  return (
    <div ref={grid} className="mx-overview-sector-grid" role="group" aria-label={label}>
      {ordered.map((group, index) => {
        const full = groupName(group, "gics", locale);
        const short = SHORT[group.key]?.[locale === "zh" ? 0 : 1] ?? full;
        const fits = !room || measureText(full, ROOMY.size, family) <= (index === 0 ? room.first : room.other);
        return (
          <Link key={group.key} href={"/sectors?market=" + market + "&sector=" + encodeURIComponent(group.key)}
            className="mx-overview-sector" data-tone={changeTone(group.change)} aria-label={spoken(group)}
            style={{ "--mx-heat-mix": heatMix(group.change, scheme) } as CSSProperties}>
            <span className="mx-overview-sector-name">{fits ? full : short}</span>
            <span className="mx-overview-sector-change">{formatDeltaPercent(group.change, locale, 2)}</span>
          </Link>
        );
      })}
    </div>
  );
}
