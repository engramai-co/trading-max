"use client";

import { Button, Tooltip, useComputedColorScheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoardResponse, SectorGroup } from "@/lib/types";
import { formatDateTime, formatDeltaPercent } from "@/ui/formatters";
import { CenteredCopy } from "@/ui/centered-copy";
import { useFinePointer } from "@/ui/pointer";
import { api } from "@/workspace/data";
import { Empty, Panel, Pending, QueryError, UpdateFailure, useCopy } from "./foundation";
import Link from "./link";
import { SectorSources, SessionClock, useMinute, usePhaseNames } from "./sectors-clock";
import { heatMix, marketPhase, squarify, type Tile } from "./sectors-data";
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

/**
 * Today's US sectors on the overview: one flat block per GICS sector, area by index weight and a wash by
 * the session's move. The board is the 板块 page's own US answer, so opening a block reuses it.
 */
export function useOverviewSectors() {
  return useQuery({
    queryKey: ["workspace-sectors", "us"],
    queryFn: ({ signal }) => api<SectorBoardResponse>("/sectors?market=us", { signal }),
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function OverviewSectors({ query, initialWaiting }: {
  query: ReturnType<typeof useOverviewSectors>;
  initialWaiting: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const now = useMinute();
  const phaseName = usePhaseNames();
  const data = query.data;
  const board = data?.board?.market === "us" ? data.board : null;
  // An answer missing its parts shows the empty board rather than breaking the overview.
  const status = data?.markets?.find((item) => item.market === "us");
  const groups = board?.groupings?.find((grouping) => grouping.kind === "gics")?.groups ?? [];
  const clock = status && board && (
    <SessionClock status={status} board={board} phase={marketPhase(status.sessions, status.timezone, now).phase}
      phaseName={phaseName} monitorOn={data?.monitor?.enabled !== false} refreshFailed={false} now={now} sources={false} />
  );
  return (
    <Panel
      className="mx-overview-sectors"
      title={t("美股板块", "US sectors")}
      help={board ? <SectorSources source={board.source} /> : undefined}
      action={<span className="mx-freshness-group">{!initialWaiting && clock}{query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}</span>}
    >
      {initialWaiting || query.isPending ? (
        <Pending shape="sectors" quiet={initialWaiting} label={t("正在读取美股板块…", "Loading US sectors…")} />
      ) : !board && query.isError ? (
        <QueryError retry={query.refetch} />
      ) : !board || !groups.length ? (
        <Empty
          title={t("还没有美股板块数据", "No US sector data yet")}
          description={data?.monitor?.enabled === false
            ? <span className="mx-sector-empty-copy">
                <CenteredCopy>{t("开启「证券研究与每日对账」", "Enable Research & daily reconciliation")}</CenteredCopy>
                <wbr />
                <CenteredCopy>{t("即可在开盘时段每 10 分钟刷新板块。", " to refresh sectors every 10 minutes during market hours.")}</CenteredCopy>
              </span>
            : data?.monitor?.nextRunAt
              ? t("下一次更新 ", "Next update ") + formatDateTime(data.monitor.nextRunAt, locale, timeZone)
              : undefined}
          action={data?.monitor?.enabled === false
            ? <Button component={Link} href="/settings" variant="default">{t("打开设置", "Open settings")}</Button>
            : undefined}
        />
      ) : (
        <SectorBoard groups={groups} />
      )}
    </Panel>
  );
}

/**
 * A mouse gets the weighted map, whose small blocks finish their labels on hover. Phones and touch get one equal
 * block per sector instead, each large enough to tap and to carry its whole move. Stylesheets choose between them
 * too, so neither shows before the pointer is known.
 */
function SectorBoard({ groups }: { groups: SectorGroup[] }) {
  const t = useCopy();
  const fine = useFinePointer();
  const phone = useMediaQuery("(max-width: 767px)") ?? false;
  return (
    <>
      {fine && !phone && <SectorMap groups={groups} label={t("美股板块地图", "US sector map")} />}
      <SectorGrid groups={groups} label={t("美股板块", "US sectors")} />
    </>
  );
}

/** The accessible name of a sector block: its full name and two-decimal move, whatever the block shows. */
function useSpoken() {
  const { locale } = useLocale();
  return (group: SectorGroup) => groupName(group, "gics", locale) + " " + formatDeltaPercent(group.change, locale, 2);
}

function SectorMap({ groups, label }: { groups: SectorGroup[]; label: string }) {
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
            <Link href={"/sectors?market=us&sector=" + encodeURIComponent(group.key)} {...attributes} aria-label={spoken(group)}>
              {content}
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Phones and touch: blocks in index-weight order, each opening its sector, with the full name where it fits. */
function SectorGrid({ groups, label }: { groups: SectorGroup[]; label: string }) {
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
          <Link key={group.key} href={"/sectors?market=us&sector=" + encodeURIComponent(group.key)}
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
