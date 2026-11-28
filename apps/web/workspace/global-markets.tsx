"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { useMediaQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { formatCalendarDate, formatDateTime, formatDeltaPercent, formatNumber } from "@/ui/formatters";
import { presentationLink } from "./desktop-routing";
import { Empty, Help, Pending, QueryError, QueryReadStatus, Tag, useCopy, useEscapeLayer } from "./foundation";
import { CHINA_MAP_INDEX, globalHeatStyle, globalMarketReading, useGlobalContribution, type GlobalMapMarket } from "./global-markets-data";
import { MARKET_PATHS, WIDE_WORLD_VIEWBOX, WORLD_LAND, WORLD_VIEWBOX } from "./global-market-geometry";
import { PageInspection } from "./assistant/inspection-entry";
import { useAssistant } from "./assistant/context";
import Link from "./link";
import { heat } from "./sectors-data";
import { changeTone } from "./sectors-map";

type MapMarket = GlobalMapMarket;
type Market = MapMarket | "em";

type Label = {
  name: [string, string];
  label: [number, number];
  point?: [number, number];
  phone: [number, number];
  compact: [number, number];
};
const MAP: Record<MapMarket, Label> = {
  ca: { name: ["加拿大", "Canada"], label: [227, 56], phone: [221, 60], compact: [205, 62] },
  us: { name: ["美国", "US"], label: [209, 100], phone: [194, 164], compact: [194, 186] },
  uk: { name: ["英国", "UK"], label: [365, 34], point: [397, 61], phone: [334, 60], compact: [330, 62] },
  eu: { name: ["欧洲", "Europe"], label: [439, 57], phone: [452, 65], compact: [455, 62] },
  ch: { name: ["瑞士", "Switzerland"], label: [451, 115], point: [415, 75], phone: [440, 174], compact: [420, 186] },
  jp: { name: ["日本", "Japan"], label: [718, 68], point: [671, 101], phone: [723, 60], compact: [723, 62] },
  // China's phone label sits west of the coast, so its target stops short of Korea and Japan.
  cn: { name: ["中国", "China"], label: [600, 112], phone: [585, 80], compact: [580, 62] },
  kr: { name: ["韩国", "Korea"], label: [727, 109], point: [650, 101], phone: [723, 164], compact: [723, 186] },
  hk: { name: ["香港", "Hong Kong"], label: [707, 156], point: [637, 138], phone: [723, 268], compact: [723, 310] },
  tw: { name: ["台湾", "Taiwan"], label: [720, 202], point: [654, 139], phone: [610, 298], compact: [599, 310] },
  in: { name: ["印度", "India"], label: [558, 142], phone: [545, 186], compact: [548, 186] },
  au: { name: ["澳洲", "Australia"], label: [683, 279], phone: [498, 294], compact: [474, 310] },
};

const INDEX_NAMES: Record<string, readonly [string, string]> = {
  [CHINA_MAP_INDEX.id]: CHINA_MAP_INDEX.name,
  "sp-500": ["标普 500", "S&P 500"],
  "sp-tsx": ["TSX", "TSX"],
  "ftse-100": ["富时 100", "FTSE 100"],
  "euro-stoxx-50": ["欧洲斯托克 50", "EURO STOXX 50"],
  "stoxx-europe-600": ["STOXX 600", "STOXX 600"],
  "smi": ["SMI", "SMI"],
  "nikkei-225": ["日经 225", "Nikkei 225"],
  "asx-200": ["ASX 200", "ASX 200"],
  "hang-seng": ["恒生指数", "Hang Seng"],
  kospi: ["韩国综合指数", "KOSPI"],
  taiex: ["台湾加权指数", "TAIEX"],
  "nifty-50": ["印度 Nifty 50", "Nifty 50"],
  "msci-em": ["MSCI EM", "MSCI EM"],
};

const MAP_INDEX: Record<MapMarket, string> = {
  us: "sp-500", ca: "sp-tsx", uk: "ftse-100", eu: "stoxx-europe-600", ch: "smi",
  jp: "nikkei-225", au: "asx-200", hk: "hang-seng", cn: CHINA_MAP_INDEX.id, kr: "kospi", tw: "taiex", in: "nifty-50",
};
const EM_MARKETS = new Set<Market>(["cn", "kr", "tw", "in"]);

type MapAnchor = HTMLAnchorElement | SVGAElement;

type Box = { left: number; top: number; right: number; bottom: number };
type InspectionPlacement = { x: number; y: number } | "below-map";
const PHONE_HIT_SIZE = 44;
const WORLD_VIEWBOX_WIDTH = 774;
// The tighter label positions accommodate 44 CSS px targets on the narrowest phones.
const COMPACT_LABEL_TARGET = 103;
const COMPACT_WORLD_VIEWBOX = "12 0 774 372";

/**
 * Where the inspection card sits: above, below, right or left of the market, inside the
 * map, covering the fewest other market labels. Ties keep that order.
 */
export function placeInspection(anchor: Box, size: { width: number; height: number }, bounds: { width: number; height: number }, labels: Box[], keepTargetsClear = false) {
  const gap = 8, pad = 8;
  const { width, height } = size;
  const clampX = (x: number) => Math.max(pad, Math.min(x, bounds.width - width - pad));
  const clampY = (y: number) => Math.max(pad, Math.min(y, bounds.height - height - pad));
  const centreX = (anchor.left + anchor.right) / 2, centreY = (anchor.top + anchor.bottom) / 2;
  const candidates = [
    { x: clampX(centreX - width / 2), y: anchor.top - gap - height },
    { x: clampX(centreX - width / 2), y: anchor.bottom + gap },
    { x: anchor.right + gap, y: clampY(centreY - height / 2) },
    { x: anchor.left - gap - width, y: clampY(centreY - height / 2) },
  ];
  const inside = (c: { x: number; y: number }) => c.x >= pad - 0.5 && c.y >= pad - 0.5
    && c.x + width <= bounds.width - pad + 0.5 && c.y + height <= bounds.height - pad + 0.5;
  const overlap = (c: { x: number; y: number }, box: Box) =>
    Math.max(0, Math.min(c.x + width, box.right) - Math.max(c.x, box.left)) * Math.max(0, Math.min(c.y + height, box.bottom) - Math.max(c.y, box.top));
  // Covering the market itself is worse than covering a neighbour's label.
  const cost = (c: { x: number; y: number }) => labels.reduce((sum, box) => sum + overlap(c, box), 0) + overlap(c, anchor) * 4;
  const fitting = candidates.filter(inside);
  const best = fitting.reduce<{ x: number; y: number } | null>((chosen, c) => !chosen || cost(c) < cost(chosen) ? c : chosen, null);
  if (keepTargetsClear && (!best || cost(best) > 0)) return "below-map";
  return best ?? { x: clampX(centreX - width / 2), y: clampY(anchor.bottom + gap) };
}

function tone(value: number) {
  return value < 0 ? "down" : value > 0 ? "up" : "flat";
}

export function GlobalMarkets({ demo, onMarket }: { demo: boolean; onMarket: (market: MapMarket, fromMap: boolean) => void }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const pathname = usePathname();
  const touchMap = useMediaQuery("(max-width: 767px) and (pointer: coarse)");
  const [wide, setWide] = useState(false);
  const [phoneHit, setPhoneHit] = useState(100);
  const worldSvg = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<Market | null>(null);
  const [focused, setFocused] = useState<Market | null>(null);
  const [inspection, setInspection] = useState<MapMarket | null>(null);
  const [placement, setPlacement] = useState<InspectionPlacement | null>(null);
  const mapHost = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const inspectionHeading = useRef<HTMLDivElement>(null);
  const detailLink = useRef<HTMLAnchorElement>(null);
  const trigger = useRef<MapAnchor | null>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = hovered ?? inspection ?? focused;
  const compact = phoneHit > COMPACT_LABEL_TARGET;
  const cancelDismiss = useCallback(() => {
    if (closeTimer.current != null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelDismiss();
    pinned.current = false;
    setInspection(null);
  }, [cancelDismiss]);
  useEffect(() => () => {
    if (closeTimer.current != null) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!inspection) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !mapHost.current?.contains(event.target)) close();
    };
    // Keep the contribution rows in place until an outside tap has activated its target.
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [close, inspection]);
  const title = t("对 MSCI 全球的贡献", "Contribution to MSCI ACWI");
  const query = useGlobalContribution(!demo);
  const answer = query.data;
  const {ready} = useAssistant();
  const [openingObservation,setOpeningObservation] = useState<string | null>(null);
  const [readingSlot,setReadingSlot] = useState<HTMLDivElement|null>(null);
  if (ready && !openingObservation && answer?.asOf && !answer.pricesStale && !query.isError) setOpeningObservation(answer.asOf);
  const change = (value: number | null | undefined) => formatDeltaPercent(value, locale, 2);
  const pp = (value: number) => formatNumber(value * 100, locale, {
    minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero",
  }) + " pp";
  const name = (market: Market) => market === "em" ? t("新兴市场", "Emerging markets") : t(...MAP[market].name);
  const preOpen = t("未开盘", "Not open");
  const quoteStatus = (move?: number | null, notOpen = false) => move == null ? t("无报价", "No quote")
    : notOpen ? preOpen : heat(move) === 0 ? t("持平", "Flat") : null;
  const contributionText = (market: Market, contribution?: number) => EM_MARKETS.has(market)
    ? t("计入新兴市场", "Included in emerging markets")
    : contribution == null ? t("未单列", "Not shown separately") : pp(contribution);
  const accessible = (market: Market, move?: number | null, contribution?: number, notOpen = false) => {
    const status = quoteStatus(move, notOpen);
    const parts = [
      globalMarketReading(market, name(market), locale),
      ...(status ? [status] : []),
      ...(move != null && !notOpen ? [t("涨跌 ", "Move ") + change(move)] : []),
      t("贡献 ", "Contribution ") + contributionText(market, contribution),
    ];
    return parts.join(t("，", ", "));
  };
  const inspect = (market: MapMarket, node: MapAnchor, pin = false) => {
    cancelDismiss();
    pinned.current = pin;
    trigger.current = node;
    setInspection(market);
  };
  const inspectShape = (event: MouseEvent<SVGSVGElement>) => {
    if (!touchMap || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest(".mx-global-region")) return;
    const svg = event.currentTarget;
    const transform = svg.getScreenCTM();
    if (!transform) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    // Phone label rectangles get first refusal. Bare geography still opens its own region.
    const shapes = [...svg.querySelectorAll<SVGGeometryElement>(".mx-global-shape, .mx-global-pin")];
    const node = shapes.findLast((shape) => shape.isPointInFill?.(point))?.closest<SVGAElement>(".mx-global-region");
    const market = node?.dataset.market as MapMarket | undefined;
    if (market && node) inspect(market, node, true);
  };
  useLayoutEffect(() => {
    const svg = worldSvg.current;
    const host = mapHost.current;
    if (!svg || !host) return;
    const measure = () => {
      const mapWidth = svg.getBoundingClientRect().width;
      if (mapWidth) setPhoneHit(PHONE_HIT_SIZE * WORLD_VIEWBOX_WIDTH / mapWidth);
      const wideLayout = getComputedStyle(host).getPropertyValue("--world-map-wide").trim() === "1";
      setWide(wideLayout);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [demo]);
  useEscapeLayer(inspection != null, mapHost, () => {
    // Focus inside the card goes back to the market that opened it.
    if (popover.current?.contains(document.activeElement)) trigger.current?.focus();
    close();
  });
  useLayoutEffect(() => {
    const card = popover.current, host = mapHost.current;
    if (!inspection || !card || !host) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const bounds = host.getBoundingClientRect();
      const relative = (nodes: Iterable<Element>) => Array.from(nodes)
        .map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0)
        .map((box) => ({ left: box.left - bounds.left, top: box.top - bounds.top,
          right: box.right - bounds.left, bottom: box.bottom - bounds.top }));
      const parts = relative(trigger.current?.querySelectorAll(".mx-global-hit, .mx-global-pin") ?? []);
      if (!parts.length) return;
      const anchor = {
        left: Math.min(...parts.map((box) => box.left)),
        top: Math.min(...parts.map((box) => box.top)),
        right: Math.max(...parts.map((box) => box.right)),
        bottom: Math.max(...parts.map((box) => box.bottom)),
      };
      const labels = relative(host.querySelectorAll(touchMap
        ? '.mx-global-label-phone .mx-global-hit'
        : `[data-label-market]:not([data-label-market="${inspection}"])`));
      // When the reading follows the map, measure the SVG rather than including the reading again.
      const svg = worldSvg.current?.getBoundingClientRect();
      const mapHeight = touchMap && svg
        ? svg.bottom - bounds.top + parseFloat(getComputedStyle(host).paddingBottom)
        : bounds.height;
      card.style.setProperty("--market-inspection-height", `${Math.max(0, mapHeight - 16)}px`);
      const height = touchMap ? Math.max(card.offsetHeight, card.scrollHeight + 2) : card.offsetHeight;
      const next = placeInspection(anchor, { width: card.offsetWidth, height },
        { width: bounds.width, height: mapHeight }, labels, touchMap);
      setPlacement((previous) => previous && previous !== "below-map" && next !== "below-map"
        && previous.x === next.x && previous.y === next.y ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    observer.observe(card);
    return () => observer.disconnect();
  }, [inspection, phoneHit, wide, locale, touchMap]);
  useEffect(() => {
    // A card opened by a tap or click stays in view, above the phone dock.
    if (placement && pinned.current) popover.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [inspection, placement]);
  const deferDismiss = () => {
    cancelDismiss();
    if (!pinned.current) closeTimer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current && !popover.current?.contains(document.activeElement) &&
        !popover.current?.querySelector('.mx-reading-source[aria-expanded="true"]')) close();
    }, 240);
  };
  const bindings = (market: Market) => ({
    onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType !== "touch") setHovered(market); },
    onPointerLeave: () => setHovered((value) => value === market ? null : value),
    onFocus: () => setFocused(market),
    onBlur: () => setFocused((value) => value === market ? null : value),
  });
  const url = (market: MapMarket) => `/sectors?market=${market}`;
  const open = (event: MouseEvent<HTMLAnchorElement>, market: MapMarket, fromMap = false) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onMarket(market, fromMap);
  };
  if (demo) return <Card as="section">
    <Empty headingLevel={2} title={t("演示不包含全球行情", "Global quotes aren’t included in the demo")} />
  </Card>;
  const rows = answer?.rows ?? [];
  const total = answer?.acwiMove;
  const residual = answer?.residual;
  const values = [...rows.map((row) => row.contribution), residual ?? 0];
  const limit = Math.max(0.00001, -Math.min(...values) / 0.76, Math.max(...values) / 0.24);
  const priced = total != null && residual != null && rows.length > 0;
  const coveredMarkets = answer?.markets.filter(({ move }) => move != null).length ?? 0;
  const noContribution = !answer?.weightsAsOf
    ? t("缺少带日期的 ACWI 持仓权重。请稍后重试，或单独查看各市场。", "Dated ACWI holdings weights are missing. Retry later or open a market individually.")
    : total == null
      ? t("行情源未返回同一时段的 MSCI ACWI 比较价格。请在下一交易时段重试。", "The source returned no comparable MSCI ACWI prices for this session. Retry in the next session.")
      : t("成分报价尚不足以估算贡献。请稍后重试。", "There are too few constituent quotes to estimate contribution. Retry later.");
  const inspectedMove = answer?.markets.find(({ market }) => market === inspection);
  const inspectedRow = rows.find(({ market }) => market === inspection);
  const inspectedContribution = inspectedRow?.contribution;
  const inspectedStatus = quoteStatus(inspectedMove?.move, inspectedMove?.notOpen);
  return (
    <section className="mx-global-panel" aria-labelledby="mx-global-title"
      onKeyDownCapture={(event) => {
        // The reading links render through a portal, so capture on their shared React ancestor.
        if (event.key === "Tab" && event.shiftKey && event.target === popover.current?.querySelector("button, a")) {
          event.preventDefault();
          trigger.current?.focus();
        }
      }}>
      <PageInspection role="market-map" object={inspection ? name(inspection) : t("全球市场","Global markets")}
        context={openingObservation ? {observed:openingObservation} : undefined} market={inspection ?? undefined}
        showMapLine={answer?.asOf===openingObservation && !answer?.pricesStale && !query.isError}
        portal={readingSlot}
        liveRecord={answer?.asOf && !answer.pricesStale && !query.isError && inspectedMove ? {
          observed:answer.asOf, heading:inspectionHeading,
          figures:[answer.referenceDate, inspectedMove.move, inspectedMove.notOpen,
            !inspectedRow?.notOpen && !answer.weightsStale ? inspectedContribution ?? null : null],
        } : undefined}/>
      <header className="mx-global-lead">
        <div className="mx-global-heading flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 id="mx-global-title">{title}</h2>
          <Help label={title} tag={<Tag tone="warn">{t("估算", "Estimate")}</Tag>}
            basis={<>{t("权重来自 iShares MSCI ACWI UCITS ETF（SSAC）持仓，按所在地汇总", "Weights come from iShares MSCI ACWI UCITS ETF (SSAC) holdings, grouped by location")}
              {answer?.weightsAsOf && <>{t("，持仓截至 ", ", as of ")}{formatCalendarDate(answer.weightsAsOf, locale)}</>}
              {t("。以 MSCI 全球的最近一次收盘划分交易日。", ". The latest MSCI ACWI close separates global sessions.")}</>}>
            <p>{t("已单列的发达市场：权重 × 主要指数的本币涨跌。新兴市场：合计权重 × MSCI EM 的美元涨跌。尚未开盘的市场贡献为零。", "For each listed developed market: weight × local-currency move in its main index. For emerging markets: combined weight × the USD move in MSCI EM. Markets yet to open contribute zero.")}</p>
            <p>{t("汇率与其他 = MSCI 全球涨跌减去已列贡献，包含汇率、未覆盖市场和估算误差。", "Currency and other is the MSCI ACWI move less the listed contributions. It includes currency effects, markets outside the estimate and approximation error.")}</p>
          </Help>
        </div>
        <div className="mx-global-summary">
          {total != null && <div className="mx-global-move" data-tone={tone(total)}>{change(total)}</div>}
          {(query.isError && answer || answer?.weightsStale || answer?.pricesStale || answer?.state === "partial") && <div className="mx-global-caveats flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground" role="status">
            {query.isError && answer && <Tag tone="warn">{t("刷新失败", "Refresh failed")}</Tag>}
            {answer?.pricesStale && <Tag tone="warn">{answer.asOf
              ? t("报价未更新 · ", "Quotes haven’t updated · ") + formatDateTime(answer.asOf, locale, timeZone)
              : t("报价暂不可用", "Quotes temporarily unavailable")}</Tag>}
            {answer?.weightsStale && <Tag tone="warn">{t("权重未更新", "Weights haven’t updated")}</Tag>}
            {answer?.state === "partial" && <Tag tone="warn">{t("部分报价不可用", "Partial quote coverage")}</Tag>}
          </div>}
        </div>
        <p className="mx-global-colour-key my-[5px] text-xs text-muted-foreground">{t("地图颜色：各市场指数的本币涨跌", "Map colours: local index moves")}</p>
      </header>
      <div
        ref={mapHost}
        className="mx-global-map"
        data-testid="global-map"
      >
        <svg
          ref={worldSvg}
          onClick={inspectShape}
          viewBox={wide ? WIDE_WORLD_VIEWBOX : compact ? COMPACT_WORLD_VIEWBOX : WORLD_VIEWBOX}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={t("全球市场地图", "World market map")}
        >
          <path className="mx-global-land fill-world-land" d={WORLD_LAND} fillRule="evenodd" />
          {(Object.entries(MAP) as [MapMarket, Label][]).map(([market, { label, phone, compact: compactLabel, point }]) => {
            const reading = answer?.markets.find((item) => item.market === market);
            const move = reading?.move;
            const row = rows.find((item) => item.market === market);
            // Focusing the EM aggregate outlines all of its mapped markets.
            const selected = active === market || (active === "em" && EM_MARKETS.has(market));
            const style = globalHeatStyle(move);
            const regionTone = reading?.notOpen || move == null ? undefined : changeTone(move);
            return <a key={market} href={presentationLink(pathname, url(market)).href}
              className="mx-global-region tm-world-region"
              tabIndex={0}
              data-market={market}
              data-tone={regionTone}
              data-neutral={reading?.notOpen || style["--mx-world-heat-light"] === "0%" || undefined}
              data-linked={selected || undefined}
              aria-label={accessible(market, move, row?.contribution, reading?.notOpen)} style={style}
              aria-expanded={inspection === market}
              aria-controls={inspection === market ? "mx-global-inspection" : undefined}
              aria-details={inspection === market ? "mx-global-inspection" : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") inspect(market, event.currentTarget);
              }}
              onPointerLeave={deferDismiss}
              onFocus={(event) => inspect(market, event.currentTarget)}
              onBlur={(event) => {
                if (event.relatedTarget instanceof Node && popover.current?.contains(event.relatedTarget)) return;
                deferDismiss();
              }}
              onClick={(event) => {
                if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                inspect(market, event.currentTarget, true);
                if (event.detail === 0) requestAnimationFrame(() => detailLink.current?.focus());
              }}
              onKeyDown={(event) => {
                if ((event.key === "Tab" && !event.shiftKey) && inspection === market) {
                  event.preventDefault();
                  (popover.current?.querySelector<HTMLElement>("button, a") ?? detailLink.current)?.focus();
                }
              }}>
              {market !== "hk" && <path className="mx-global-shape tm-world-shape" d={MARKET_PATHS[market]} fillRule="evenodd" />}
              {point && <circle className="mx-global-pin tm-world-pin" cx={point[0]} cy={point[1]} r={market === "hk" ? 4.5 : 3.4} />}
              <MapLabel market={market} label={name(market)} position={label} point={point} />
              <MapLabel position={compact ? compactLabel : phone} point={point ?? label} phone hitSize={phoneHit} />
            </a>;
          })}
          {/* Paint phone names above every geography shape while the links own the hit targets. */}
          <g className="tm-world-region tm-world-label-phone pointer-events-none" aria-hidden="true">
            {(Object.entries(MAP) as [MapMarket, Label][]).map(([market, { phone, compact: compactLabel }]) => {
              const [x, y] = compact ? compactLabel : phone;
              return <text key={market} data-label-market={market} x={x} y={y}
                textAnchor="middle" dominantBaseline="central">{name(market)}</text>;
            })}
          </g>
        </svg>
        {inspection && <div
          ref={popover} id="mx-global-inspection" className="mx-global-inspection tm-floating-surface" role="group" aria-labelledby="mx-global-inspection-title"
          data-below-map={placement === "below-map" || undefined}
          style={placement === "below-map" ? undefined : placement ? { left: placement.x, top: placement.y } : { visibility: "hidden" }}
          onPointerEnter={cancelDismiss} onPointerLeave={() => {
            if (!popover.current?.contains(document.activeElement)) deferDismiss();
          }}
          onFocus={cancelDismiss} onBlur={(event) => {
            if (event.relatedTarget instanceof Element &&
              (event.currentTarget.contains(event.relatedTarget) || event.relatedTarget.closest(".mx-global-region, .mx-citation-preview"))) return;
            close();
          }}>
          <div id="mx-global-inspection-title" ref={inspectionHeading} tabIndex={-1} className="mx-global-inspect-head font-medium text-muted-foreground">{name(inspection)} · {t(...INDEX_NAMES[MAP_INDEX[inspection]])}</div>
          {/* Not open hides the move, flat keeps it in ink, no quote shows none. */}
          <div className="mx-global-inspect-move"
            data-tone={inspectedMove?.move != null && !inspectedMove.notOpen && !inspectedStatus ? tone(inspectedMove.move) : undefined}>
            {inspectedMove?.move == null || inspectedMove.notOpen ? <span data-status="">{inspectedStatus}</span>
              : <>{change(inspectedMove.move)}{inspectedStatus && <span data-status="">{inspectedStatus}</span>}</>}
          </div>
          <dl className="mx-global-inspect-rows m-0">
            <div><dt>{t("贡献", "Contribution")}</dt>
              <dd>{inspectedContribution == null ? contributionText(inspection) : pp(inspectedContribution)}</dd></div>
          </dl>
          {ready && <div ref={setReadingSlot}/>}
          <Link ref={detailLink} href={url(inspection)} prefetch={false} data-slot="button"
            className={buttonVariants({ variant: "link", className: "justify-self-start px-0" })}
            onClick={(event) => open(event, inspection, true)} onKeyDown={(event) => {
              if (event.key !== "Tab" || event.shiftKey) return;
              const regions = Array.from(mapHost.current?.querySelectorAll<MapAnchor>(".mx-global-region") ?? []);
              const source = trigger.current;
              if (!source) return;
              const next = regions[regions.indexOf(source) + 1];
              if (next) {
                event.preventDefault();
                next.focus();
              }
            }}>
            {t("打开市场", "Open market")}
          </Link>
        </div>}
      </div>
      <div className="mx-global-ranking">
        <QueryReadStatus label={t("全球行情", "Global quotes")} failed={query.isError && !answer} ready={!!answer} error={query.error} />
        {query.isError && !answer ? <QueryError retry={query.refetch} showDataStatusLink={false} />
          : query.isPending ? <Pending label={t("正在加载贡献", "Loading contributions")} compact />
          : !priced ? <div className="mx-global-status my-2 flex items-center gap-2 text-muted-foreground" role="status">
            <div><strong>{t("暂无可用的贡献估算", "No contribution estimate available")}</strong>
              <p>{noContribution}</p>
              {answer && <p>{t("本地行情覆盖", "Local quote coverage")} · {coveredMarkets} / {answer.markets.length}
                {answer.asOf && <> · <time dateTime={answer.asOf}>{formatDateTime(answer.asOf, locale, timeZone)}</time></>}</p>}
            </div>
            <Button variant="link" className="mx-index-retry px-0" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {t("重试", "Retry")}
            </Button>
          </div> : null}
        {priced && <>
          <ul className="mx-global-rows m-0 list-none p-0">
            {rows.map(({ market, indexId, move, contribution, notOpen }) => {
              const selected = active === market || (market === "em" && active != null && EM_MARKETS.has(active));
              const index = INDEX_NAMES[indexId];
              const status = quoteStatus(move, notOpen);
              const label = <span className="mx-global-row-label self-center py-1 pr-[3px]">
                <strong>{name(market)} · {index ? t(...index) : indexId}</strong>
                <small>{notOpen ? preOpen : <><span className="sr-only">{status ? status + t("，", ", ") : ""}{t("涨跌 ", "Move ")}</span>{change(move)}</>}</small>
              </span>;
              const content = <>{label}<ContributionBar value={contribution} limit={limit} /><span className="mx-global-pp self-center text-right [overflow-wrap:anywhere]"><span className="sr-only">{t("贡献 ", "Contribution ")}</span>{pp(contribution)}</span></>;
              return <li key={market}>
                {market === "em" ? <Link className="mx-global-row" href="/sectors?market=global&index=msci-em" prefetch={false}
                  data-linked={selected || undefined} {...bindings(market)}>{content}</Link>
                : <Link className="mx-global-row" href={url(market)} prefetch={false} data-market={market} data-linked={selected || undefined}
                  onClick={(event) => open(event, market)} {...bindings(market)}>
                  {content}
                </Link>}
              </li>;
            })}
            <li className="mx-global-row mx-global-residual">
              <strong>{t("汇率与其他", "Currency and other")}</strong>
              <ContributionBar value={residual} limit={limit} /><span className="mx-global-pp self-center text-right [overflow-wrap:anywhere]">{pp(residual)}</span>
            </li>
          </ul>
          <div className="mx-global-total flex items-center justify-between gap-3 border-t border-border px-[5px] pt-1.5 text-base"><strong>{t("合计", "Total")}</strong><strong data-tone={tone(total)}>{change(total)}</strong></div>
        </>}
      </div>
    </section>
  );
}

function MapLabel({ market, label, position: [x, y], point, phone, hitSize = 100 }: {
  market?: MapMarket;
  label?: string;
  position: [number, number];
  point?: [number, number];
  phone?: boolean;
  hitSize?: number;
}) {
  const width = phone ? hitSize : 50;
  const height = phone ? hitSize : 34;
  return (
    <g
      className={phone ? "mx-global-label-phone tm-world-label-phone" : "mx-global-label-desktop tm-world-label-desktop"}
      aria-hidden="true"
    >
      {point && <path className="mx-global-leader tm-world-leader" d={`M${point.join(",")} L${x},${y}`} />}
      <rect className="mx-global-hit tm-world-hit" x={x - width / 2} y={y - height / 2} width={width} height={height} rx="4" />
      {label && <text data-label-market={market} x={x} y={y} textAnchor="middle" dominantBaseline="central">{label}</text>}
    </g>
  );
}

function ContributionBar({ value, limit }: { value: number; limit: number }) {
  const dir = tone(value);
  return (
    <span
      className="mx-global-bar relative col-start-2 flex items-center after:absolute after:inset-y-0 after:left-[76%] after:w-px after:bg-border-strong after:content-['']"
      data-tone={dir}
      aria-hidden="true"
    >
      <i
        className={cn(
          "absolute h-3.5 max-[767px]:h-[11px]",
          dir === "down" ? "right-[24%] bg-loss" : dir === "up" ? "left-[76%] bg-gain" : "",
        )}
        style={{ width: `${Math.abs(value) / limit * 100}%` }}
      />
    </span>
  );
}
