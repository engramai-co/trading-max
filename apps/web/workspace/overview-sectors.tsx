"use client";

import { ChevronDown } from "lucide-react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useComputedColorScheme } from "@/components/color-scheme-provider";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBreakpoint } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import {
  useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode,
} from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoardResponse, SectorGroup, SectorMarketCode } from "@/lib/types";
import { formatCalendarDate, formatDate, formatDateTime, formatDeltaPercent } from "@/ui/formatters";
import { CenteredCopy } from "@/ui/centered-copy";
import { useFinePointer } from "@/ui/pointer";
import { api, percent, tone } from "@/workspace/data";
import { Empty, Panel, Pending, ReadStatus, Tag, Tip, UpdateFailure, useCopy } from "./foundation";
import { globalMarketContributionKey, globalMarketReading, useGlobalContribution, type GlobalMarketContribution } from "./global-markets-data";
import Link from "./link";
import { InlineRetry } from "./dashboard-controls";
import { SectorSources, SessionClock, useMinute, usePhaseNames } from "./sectors-clock";
import { SECTOR_MARKETS, heatMix, marketPhase, sectorMarket, squarify, type Tile } from "./sectors-data";
import { changeTone, groupName } from "./sectors-map";
import {
  fitTileLabel,
  measureTileText,
  TILE_TIERS,
  TILE_TIER_PADDING,
  TILE_TIER_TEXT,
  useMeasuredBox,
} from "./tile-layout";

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
function selectedOverviewMarket(stored: string | null): OverviewMarket {
  return stored === "global" ? "global" : sectorMarket(stored) ?? "us";
}

const overviewSectorsKey = (market: SectorMarketCode | null) => ["workspace-sectors", market] as const;

export function retryOverviewMarket(client: QueryClient) {
  const market = selectedOverviewMarket(readMarket());
  const queryKey = market === "global" ? globalMarketContributionKey : overviewSectorsKey(market);
  return client.refetchQueries({ queryKey, exact: true, type: "active" }, { cancelRefetch: false });
}

/** Null until the browser has been read, so the first request is already the chosen market's. */
function useOverviewMarket() {
  const stored = useSyncExternalStore<string | null | undefined>(subscribeMarket, readMarket, () => undefined);
  const market = stored === undefined ? null : selectedOverviewMarket(stored);
  return [market, chooseMarket] as const;
}

/**
 * Today's sectors on the overview, the US unless the reader picks another market: one flat block per GICS sector,
 * area by index weight and a wash by the session's move. The board is the Markets page's own answer, so opening a
 * block reuses it. Global shows the markets themselves as a block world map.
 */
function useOverviewSectors(market: SectorMarketCode | null) {
  return useQuery({
    queryKey: overviewSectorsKey(market),
    queryFn: ({ signal }) => api<SectorBoardResponse>("/sectors?market=" + market, { signal }),
    enabled: market !== null,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function OverviewSectors({ online, sharedRecovery = false }: { online: boolean; sharedRecovery?: boolean }) {
  const t = useCopy();
  const [market, choose] = useOverviewMarket();
  const restoreMarketFocus = useRef(false);
  const marketTrigger = useCallback((node: HTMLButtonElement | null) => {
    if (!node || !restoreMarketFocus.current) return;
    restoreMarketFocus.current = false;
    node.focus({ preventScroll: true });
  }, []);
  const name = (value: string) => {
    const names = MARKET_NAMES[value];
    return names ? t(names[0], names[1]) : value.toUpperCase();
  };
  const title = market === "global" ? t("全球市场", "Global markets")
    : market ? name(market) + t("板块", " sectors") : t("板块", "Sectors");
  const picker = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={
        <button ref={marketTrigger} type="button" className="mx-overview-market" aria-label={t("选择市场，当前：", "Choose market, now: ") + title}>
          {title}
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      } />
      <DropdownMenuContent aria-label={t("选择市场", "Choose market")}>
        {(["global", ...SECTOR_MARKETS] as OverviewMarket[]).map((value) => (
          <DropdownMenuItem key={value} aria-current={value === market ? "true" : undefined} onClick={() => {
            // The global and single-market panels own separate trigger elements.
            restoreMarketFocus.current = value !== market && (value === "global" || market === "global");
            choose(value);
          }}>
            {name(value)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (market === null) return (
    <Panel className="mx-overview-sectors mx-overview-sectors-pending" title={picker}>
      <Pending shape="sectors" quiet />
    </Panel>
  );
  return market === "global"
    ? <GlobalPanel title={title} picker={picker} online={online} sharedRecovery={sharedRecovery} />
    : <SectorPanel market={market} title={title} picker={picker} online={online} sharedRecovery={sharedRecovery} />;
}

function SectorPanel({ market, title, picker, online, sharedRecovery }: {
  market: SectorMarketCode; title: string; picker: ReactNode; online: boolean; sharedRecovery: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const now = useMinute();
  const phaseName = usePhaseNames();
  const query = useOverviewSectors(market);
  const retry = sharedRecovery ? undefined : query.refetch;
  const offline = !online || query.fetchStatus === "paused";
  const offlineLabel = t("网络已断开，板块行情将在重连后更新。", "You’re offline. Sector quotes will update when you reconnect.");
  const unavailable = t("板块行情暂不可用", "Sector quotes unavailable");
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
      className={"mx-overview-sectors" + (query.isPending && !offline ? " mx-overview-sectors-pending" : "")}
      title={picker}
      helpLabel={title}
      help={board ? <SectorSources source={board.source} /> : undefined}
      action={<span className="mx-freshness-group">{clock}{query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={retry} />}</span>}
    >
      <ReadStatus failure={query.isError && !offline ? unavailable : undefined} ready={query.isSuccess && !offline}
        recovered={t("板块行情已恢复。", "Sector quotes are available again.")} />
      {offline && <p className="mx-waiting-as-of">{offlineLabel}</p>}
      {query.isPending ? (
        <Pending shape="sectors" quiet={offline} label={t("正在读取", "Loading ") + title + t("…", "…")} />
      ) : !board && query.isError ? (
        !offline && <div className="mx-overview-unavailable"><InlineRetry label={unavailable} retry={retry} /></div>
      ) : !board || !groups.length ? (
        <Empty
          title={t("还没有板块数据", "No sector data yet")}
          description={data?.monitor?.enabled === false
            ? <span className="mx-sector-empty-copy">
                <CenteredCopy>{t("开启「研究与每日对账」", "Enable Research & daily reconciliation")}</CenteredCopy>
                <wbr />
                <CenteredCopy>{t("即可在交易时段刷新板块。", " to refresh sectors during market hours.")}</CenteredCopy>
              </span>
            : data?.monitor?.nextRunAt
              ? t("下一次更新 ", "Next update ") + formatDateTime(data.monitor.nextRunAt, locale, timeZone)
              : undefined}
          action={data?.monitor?.enabled === false
            ? <Link href="/settings" data-slot="button" className={buttonVariants({ variant: "secondary" })}>{t("打开设置", "Open settings")}</Link>
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

function GlobalPanel({ title, picker, online, sharedRecovery }: {
  title: string; picker: ReactNode; online: boolean; sharedRecovery: boolean;
}) {
  const t = useCopy();
  const fine = useFinePointer();
  const phone = useBreakpoint("phone");
  const query = useGlobalContribution(true);
  const retry = sharedRecovery ? undefined : query.refetch;
  const offline = !online || query.fetchStatus === "paused";
  const offlineLabel = t("网络已断开，全球行情将在重连后更新。", "You’re offline. Global quotes will update when you reconnect.");
  const unavailable = t("全球行情暂不可用", "Global quotes unavailable");
  const answer = query.data;
  const markets = (answer?.markets ?? []).filter((item) => item.market in WORLD);
  const weighted = markets.some((item) => (item.weight ?? 0) > 0);
  // The map leaves no ocean corner, so the world index moves to the heading beside the clock.
  const mapped = Boolean(fine && !phone && weighted);
  return (
    <Panel
      className={"mx-overview-sectors" + (query.isPending && !offline ? " mx-overview-sectors-pending" : "")}
      title={picker}
      helpLabel={title}
      help={<p>{weighted ? t(
        "面积是各市场在 MSCI 全球指数中的占比；颜色是该市场主要股指的当日涨跌，越深涨跌越大。点开一块查看该市场。",
        "Area is each market’s share of MSCI ACWI; colour is the day’s move in its main index, deeper for a bigger move. Open a block for that market.",
      ) : t(
        "每块是该市场主要股指的当日涨跌，颜色越深，涨跌越大。点开一块查看该市场。",
        "Each block is the day’s move in that market’s main index; deeper colour means a bigger move. Open a block for that market.",
      )}</p>}
      helpBasis={weighted ? t(
        "占比按 iShares MSCI ACWI 的持仓计算；涨跌取各市场主要股指的当日行情。",
        "Shares come from iShares MSCI ACWI holdings; moves are each market’s main index today.",
      ) : undefined}
      action={<span className="mx-freshness-group">
        {answer && mapped && <AcwiTotal move={answer.acwiMove} />}
        {answer && <GlobalStamp answer={answer} />}
        {query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={retry} />}</span>}
    >
      <ReadStatus failure={query.isError && !offline ? unavailable : undefined} ready={query.isSuccess && !offline}
        recovered={t("全球行情已恢复。", "Global quotes are available again.")} />
      {offline && <p className="mx-waiting-as-of">{offlineLabel}</p>}
      {query.isPending ? (
        <Pending shape="sectors" quiet={offline} label={t("正在读取全球市场…", "Loading global markets…")} />
      ) : !answer && query.isError ? (
        !offline && <div className="mx-overview-unavailable"><InlineRetry label={unavailable} retry={retry} /></div>
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
  const scheme = useComputedColorScheme("dark");
  const total = formatDeltaPercent(acwiMove, locale, 2);
  // With weights, phones read the blocks by share, the largest first.
  const order = weighted
    ? markets.toSorted((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || WORLD_ORDER.indexOf(a.market) - WORLD_ORDER.indexOf(b.market))
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
          // China's block shows a short name, so its full name and move also show on hover and focus.
          <Tip key={market} disabled={market !== "cn"} describes={false}
            label={<TipLines name={globalMarketReading(market, full, locale)} figures={[change]} />}>
          <Link href={"/sectors?market=" + market}
            className="mx-overview-sector tm-heat-surface tm-tile-interactive relative flex flex-col justify-center gap-[1px] overflow-clip rounded-[6px] px-1.5 py-2 text-foreground no-underline"
            style={style}
            data-tone={idle ? undefined : changeTone(move)} data-idle={idle ? "" : undefined}
            aria-label={reading}>
            <span className="mx-overview-sector-name truncate text-[13px] font-semibold leading-[18px]">{locale === "zh" ? full : place.short}</span>
            {/* A narrow card rounds to one decimal; the accessible name keeps both. */}
            <span className={cn("mx-overview-sector-change truncate tabular-nums", idle ? "text-xs font-medium leading-[18px] text-muted-foreground" : "text-[13px] font-semibold leading-[18px]")}>
              {idle ? change : <>
                <span className="mx-overview-world-full">{change}</span>
                <span className="mx-overview-world-short">{formatDeltaPercent(move, locale, 1)}</span>
              </>}
            </span>
          </Link>
          </Tip>
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
  const scheme = useComputedColorScheme("dark");
  const map = useRef<HTMLDivElement>(null);
  const { size, measure, budgets } = useMeasuredBox(map);
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
        const shown = fitTileLabel({
          names: names(tile.key),
          change: SAMPLE_MOVE.full,
          rounded: SAMPLE_MOVE.rounded,
          width: tile.w,
          height: tile.h,
          measure,
          tiers: budgets.tiers,
          gapX: budgets.gapInline,
          gapY: 1,
        });
        return sum + (shown.showName ? 0 : 2) + (tile.key === "other" || shown.showChange ? 0 : 1);
      }, 0);
      if (!best || lost < best.lost) best = { tiles: laid, lost };
      if (lost === 0) break;
    }
    return best?.tiles ?? [];
    // The weights string stands for the items: a refresh that only changes moves keeps the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights, size, measure, budgets, names]);
  const byMarket = new Map(markets.map((item) => [item.market as WorldKey, item]));
  return (
    <div ref={map} className="mx-overview-sector-map mx-overview-world-map" role="group" aria-label={label}>
      {tiles.map(({ key, x: left, y: top, w: width, h: height }) => {
        const item = byMarket.get(key);
        const share = key === "other" ? other : item?.weight ?? 0;
        const idle = !item || item.notOpen || item.move == null;
        const change = item ? worldChange(item, locale, 2, t) : "";
        const shown = fitTileLabel({
          names: names(key),
          change,
          rounded: item ? worldChange(item, locale, 1, t) : "",
          width,
          height,
          measure,
          tiers: budgets.tiers,
          gapX: budgets.gapInline,
          gapY: 1,
        });
        const name = key === "other" ? t("其他市场", "Other markets") : names(key).full;
        const reading = [globalMarketReading(key, name, locale), change].filter(Boolean).join(" ");
        const spoken = locale === "zh"
          ? `${reading}，占比 ${percent(share, false, 1)}`
          : `${reading}, ${percent(share, false, 1)} of ACWI`;
        const style = { left, top, width, height, "--mx-heat-mix": heatMix(idle ? null : item!.move, scheme) } as CSSProperties;
        // The tooltip repeats the accessible name in two lines, so it does not also describe the link.
        return (
          <Tip key={key} label={<TipLines name={globalMarketReading(key, name, locale)} figures={[change, percent(share, false, 1)]} />} describes={false}>
            <Link href={key === "other" ? "/sectors" : "/sectors?market=" + key}
              className={cn(
                "mx-overview-sector tm-heat-surface tm-tile-interactive absolute flex overflow-clip rounded-[6px] text-foreground no-underline",
                shown.inline ? "flex-row items-baseline gap-1.5" : "flex-col gap-[1px]",
                TILE_TIER_PADDING[shown.tier],
                TILE_TIER_TEXT[shown.tier],
              )}
              data-tone={idle ? undefined : changeTone(item!.move)} data-idle={idle ? "" : undefined}
              data-label-tier={shown.tier}
              data-compact={shown.tier !== "roomy" ? "" : undefined} data-tight={shown.tier === "tight" ? "" : undefined}
              data-inline={shown.inline ? "" : undefined} style={style} aria-label={spoken}>
              {shown.showName && (
                <span className={cn("mx-overview-sector-name font-semibold", shown.wrap ? "line-clamp-2 whitespace-normal" : "truncate")}
                  data-wrap={shown.wrap ? "" : undefined}>{shown.name}</span>
              )}
              {key !== "other" && shown.showChange && (
                <span className={cn("mx-overview-sector-change truncate tabular-nums", idle ? "font-medium text-muted-foreground" : "font-semibold")}>
                  {shown.change}
                </span>
              )}
            </Link>
          </Tip>
        );
      })}
    </div>
  );
}

/** A two-line tooltip: the full name, then the move and weight. */
function TipLines({ name, figures }: { name: string; figures: Array<string | null | undefined> }) {
  return <span className="mx-tooltip-stack"><span>{name}</span><span>{figures.filter(Boolean).join(" · ")}</span></span>;
}

/**
 * A mouse gets the weighted map, whose small blocks finish their labels on hover. Phones and touch get one equal
 * block per sector instead, each large enough to tap and to carry its whole move. Stylesheets choose between them
 * too, so neither shows before the pointer is known.
 */
function SectorBoard({ groups, market, label }: { groups: SectorGroup[]; market: SectorMarketCode; label: string }) {
  const t = useCopy();
  const fine = useFinePointer();
  const phone = useBreakpoint("phone");
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
  const scheme = useComputedColorScheme("dark");
  const spoken = useSpoken();
  const map = useRef<HTMLDivElement>(null);
  const { size, measure, budgets } = useMeasuredBox(map);
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
        const shown = fitTileLabel({
          names: names(byKey.get(tile.key)!),
          change: SAMPLE_MOVE.full,
          rounded: SAMPLE_MOVE.rounded,
          width: tile.w,
          height: tile.h,
          measure,
          tiers: budgets.tiers,
          gapX: budgets.gapInline,
          gapY: 1,
        });
        return sum + (shown.showName ? 0 : 2) + (shown.showChange ? 0 : 1);
      }, 0);
      if (!best || lost < best.lost) best = { tiles: laid, lost };
      if (lost === 0) break;
    }
    return best?.tiles ?? [];
    // The weights string stands for the groups: a refresh that only changes moves keeps the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights, size, measure, budgets, names]);
  const byKey = new Map(groups.map((group) => [group.key, group]));
  return (
    <div ref={map} className="mx-overview-sector-map" role="group" aria-label={label}>
      {tiles.map(({ key, x: left, y: top, w: width, h: height }) => {
        const group = byKey.get(key);
        if (!group) return null;
        const shown = fitTileLabel({
          names: names(group),
          change: formatDeltaPercent(group.change, locale, 2),
          rounded: formatDeltaPercent(group.change, locale, 1),
          width,
          height,
          measure,
          tiers: budgets.tiers,
          gapX: budgets.gapInline,
          gapY: 1,
        });
        const style = { left, top, width, height, "--mx-heat-mix": heatMix(group.change, scheme) } as CSSProperties;
        const content = (
          <>
            {shown.showName && (
              <span className={cn("mx-overview-sector-name font-semibold", shown.wrap ? "line-clamp-2 whitespace-normal" : "truncate")}
                data-wrap={shown.wrap ? "" : undefined}>{shown.name}</span>
            )}
            {shown.showChange && <span className="mx-overview-sector-change truncate font-semibold tabular-nums">{shown.change}</span>}
          </>
        );
        const attributes = {
          className: cn(
            "mx-overview-sector tm-heat-surface tm-tile-interactive absolute flex overflow-clip rounded-[6px] text-foreground no-underline",
            shown.inline ? "flex-row items-baseline gap-1.5" : "flex-col gap-[1px]",
            TILE_TIER_PADDING[shown.tier],
            TILE_TIER_TEXT[shown.tier],
          ),
          "data-tone": changeTone(group.change),
          "data-label-tier": shown.tier,
          "data-compact": shown.tier !== "roomy" ? "" : undefined,
          "data-tight": shown.tier === "tight" ? "" : undefined,
          "data-inline": shown.inline ? "" : undefined,
          style,
        };
        // A block that leaves part of its label out shows all of it on hover and on keyboard focus. The tooltip stays
        // mounted, only disabled, so a refresh that changes what fits keeps the link and its focus.
        return (
          <Tip key={group.key} disabled={shown.complete} describes={false}
            label={<TipLines name={groupName(group, "gics", locale)} figures={[formatDeltaPercent(group.change, locale, 2), percent(group.weight, false, 1)]} />}>
            <Link href={"/sectors?market=" + market + "&sector=" + encodeURIComponent(group.key)} {...attributes} aria-label={spoken(group)}>
              {content}
            </Link>
          </Tip>
        );
      })}
    </div>
  );
}

/** Phones and touch: blocks in index-weight order, each opening its sector, with the full name where it fits. */
function SectorGrid({ groups, market, label }: { groups: SectorGroup[]; market: SectorMarketCode; label: string }) {
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("dark");
  const spoken = useSpoken();
  const grid = useRef<HTMLDivElement>(null);
  // The width a label has: the first block's own, which may be a double block, and every other block's.
  const [room, setRoom] = useState<{ first: number; other: number; fontSize: number; family: string } | null>(null);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const width = (block: Element | null) => {
        if (!block) return 0;
        const cs = getComputedStyle(block);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        return block.getBoundingClientRect().width - (pad > 0 ? pad : TILE_TIERS.roomy.padX * 2);
      };
      const nameElement = element.querySelector(".mx-overview-sector-name");
      const nameStyle = nameElement ? getComputedStyle(nameElement) : null;
      const fontSize = parseFloat(nameStyle?.fontSize ?? "") || TILE_TIERS.roomy.size;
      const family = nameStyle?.fontFamily || getComputedStyle(element).fontFamily;
      const next = { first: width(element.firstElementChild), other: width(element.lastElementChild), fontSize, family };
      setRoom((current) =>
        current &&
        Math.abs(current.first - next.first) < 1 &&
        Math.abs(current.other - next.other) < 1 &&
        current.fontSize === next.fontSize &&
        current.family === next.family
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const rootObserver = new MutationObserver(measure);
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      observer.disconnect();
      rootObserver.disconnect();
    };
  }, []);
  const ordered = useMemo(() => groups.toSorted((a, b) => b.weight - a.weight || a.key.localeCompare(b.key)), [groups]);
  return (
    <div ref={grid} className="mx-overview-sector-grid" role="group" aria-label={label}>
      {ordered.map((group, index) => {
        const full = groupName(group, "gics", locale);
        const short = SHORT[group.key]?.[locale === "zh" ? 0 : 1] ?? full;
        const fits = !room || measureTileText(full, room.fontSize, room.family) <= (index === 0 ? room.first : room.other);
        return (
          <Link key={group.key} href={"/sectors?market=" + market + "&sector=" + encodeURIComponent(group.key)}
            className="mx-overview-sector tm-heat-surface tm-tile-interactive relative flex flex-col justify-center gap-[1px] overflow-clip rounded-[6px] px-2.5 py-2 text-foreground no-underline"
            data-tone={changeTone(group.change)} aria-label={spoken(group)}
            style={{ "--mx-heat-mix": heatMix(group.change, scheme) } as CSSProperties}>
            <span className="mx-overview-sector-name truncate text-[13px] font-semibold leading-[18px]">{fits ? full : short}</span>
            <span className="mx-overview-sector-change truncate text-[13px] font-semibold leading-[18px] tabular-nums">{formatDeltaPercent(group.change, locale, 2)}</span>
          </Link>
        );
      })}
    </div>
  );
}
