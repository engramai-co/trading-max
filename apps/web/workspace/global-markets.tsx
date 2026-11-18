"use client";

import { useMediaQuery } from "@mantine/hooks";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime, formatDeltaPercent, formatNumber } from "@/ui/formatters";
import { presentationLink } from "./desktop-routing";
import { Empty, Help, Pending, QueryError, Tag, useCopy, useEscapeLayer } from "./foundation";
import { CHINA_MAP_INDEX, globalHeatStyle, globalMarketReading, useGlobalContribution, type GlobalMapMarket } from "./global-markets-data";
import { MARKET_PATHS, WIDE_WORLD_VIEWBOX, WORLD_LAND, WORLD_VIEWBOX } from "./global-market-geometry";
import { PageInspection } from "./assistant/inspection-entry";
import { useAssistant } from "./assistant/context";
import Link from "./link";
import { heat } from "./sectors-data";

type MapMarket = GlobalMapMarket;
type Market = MapMarket | "em";

type Label = {
  name: [string, string];
  label: [number, number];
  point?: [number, number];
  phone: [number, number];
};
const MAP: Record<MapMarket, Label> = {
  ca: { name: ["加拿大", "Canada"], label: [227, 56], phone: [221, 42] },
  us: { name: ["美国", "US"], label: [209, 100], phone: [194, 135] },
  uk: { name: ["英国", "UK"], label: [365, 34], point: [397, 61], phone: [334, 34] },
  eu: { name: ["欧洲", "Europe"], label: [439, 57], phone: [450, 78] },
  ch: { name: ["瑞士", "Switzerland"], label: [451, 115], point: [415, 75], phone: [459, 171] },
  jp: { name: ["日本", "Japan"], label: [718, 68], point: [671, 101], phone: [723, 35] },
  // China's phone label sits west of the coast, so its target stops short of Korea and Japan.
  cn: { name: ["中国", "China"], label: [600, 112], phone: [585, 93] },
  kr: { name: ["韩国", "Korea"], label: [727, 109], point: [650, 101], phone: [723, 127] },
  hk: { name: ["香港", "Hong Kong"], label: [719, 156], point: [637, 138], phone: [723, 218] },
  tw: { name: ["台湾", "Taiwan"], label: [720, 202], point: [654, 139], phone: [723, 307] },
  in: { name: ["印度", "India"], label: [558, 142], phone: [574, 158] },
  au: { name: ["澳洲", "Australia"], label: [683, 279], phone: [596, 280] },
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

/** Islands too small to tap on a phone get a wider, invisible target around their outline. */
const TOUCH_OUTLINE: Partial<Record<MapMarket, number>> = { jp: 16, kr: 12 };

type Box = { left: number; top: number; right: number; bottom: number };
type Inspection = { market: MapMarket; anchor: Box };

/**
 * Where the inspection card sits: above, below, right or left of the market, inside the
 * map, covering the fewest other market labels. Ties keep that order.
 */
export function placeInspection(anchor: Box, size: { width: number; height: number }, bounds: { width: number; height: number }, labels: Box[]) {
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
  return best ?? { x: clampX(centreX - width / 2), y: clampY(anchor.bottom + gap) };
}

function tone(value: number) {
  return value < 0 ? "down" : value > 0 ? "up" : "flat";
}

export function GlobalMarkets({ demo, onMarket }: { demo: boolean; onMarket: (market: MapMarket) => void }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const pathname = usePathname();
  const wide = useMediaQuery("(min-width: 1180px)") ?? false;
  const [hovered, setHovered] = useState<Market | null>(null);
  const [focused, setFocused] = useState<Market | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [placement, setPlacement] = useState<{ x: number; y: number } | null>(null);
  const mapHost = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const detailLink = useRef<HTMLAnchorElement>(null);
  const trigger = useRef<MapAnchor | null>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = hovered ?? inspection?.market ?? focused;
  const cancelDismiss = () => {
    if (closeTimer.current != null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelDismiss();
    pinned.current = false;
    setInspection(null);
  };
  useEffect(() => () => {
    if (closeTimer.current != null) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!inspection) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !mapHost.current?.contains(event.target)) {
        pinned.current = false;
        setInspection(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [inspection]);
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
    const host = mapHost.current?.getBoundingClientRect();
    // The card keeps clear of the market's visible label and pin.
    const parts = Array.from(node.querySelectorAll<SVGGraphicsElement>(".mx-global-hit, .mx-global-pin"))
      .map((item) => item.getBoundingClientRect()).filter((box) => box.width > 0);
    if (!host || !parts.length) return;
    cancelDismiss();
    pinned.current = pin;
    trigger.current = node;
    setInspection({
      market,
      anchor: {
        left: Math.min(...parts.map((box) => box.left)) - host.left,
        top: Math.min(...parts.map((box) => box.top)) - host.top,
        right: Math.max(...parts.map((box) => box.right)) - host.left,
        bottom: Math.max(...parts.map((box) => box.bottom)) - host.top,
      },
    });
  };
  useEscapeLayer(inspection != null, () => {
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
    const labels = Array.from(host.querySelectorAll<SVGTextElement>(".mx-global-region text"))
      .filter((text) => text.closest(".mx-global-region")?.getAttribute("data-market") !== inspection.market)
      .map((text) => text.getBoundingClientRect()).filter((box) => box.width > 0)
      .map((box) => ({ left: box.left - bounds.left, top: box.top - bounds.top, right: box.right - bounds.left, bottom: box.bottom - bounds.top }));
    setPlacement(placeInspection(inspection.anchor, { width: card.offsetWidth, height: card.offsetHeight },
      { width: bounds.width, height: bounds.height }, labels));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(card);
    return () => observer.disconnect();
  }, [inspection]);
  useEffect(() => {
    // A card opened by a tap or click stays in view, above the phone dock.
    if (placement && pinned.current) popover.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [placement]);
  const deferDismiss = () => {
    cancelDismiss();
    if (!pinned.current) closeTimer.current = setTimeout(close, 240);
  };
  const bindings = (market: Market) => ({
    onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType !== "touch") setHovered(market); },
    onPointerLeave: () => setHovered((value) => value === market ? null : value),
    onFocus: () => setFocused(market),
    onBlur: () => setFocused((value) => value === market ? null : value),
  });
  const url = (market: MapMarket) => `/sectors?market=${market}`;
  const open = (event: MouseEvent, market: MapMarket) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onMarket(market);
  };
  if (demo) return <section className="mx-panel">
    <Empty headingLevel={2} title={t("演示不包含全球行情", "Global quotes aren’t included in the demo")} />
  </section>;
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
  const inspectedMove = answer?.markets.find(({ market }) => market === inspection?.market);
  const inspectedContribution = rows.find(({ market }) => market === inspection?.market)?.contribution;
  const inspectedStatus = quoteStatus(inspectedMove?.move, inspectedMove?.notOpen);
  return (
    <section className="mx-global-panel" aria-labelledby="mx-global-title">
      <PageInspection role="market-map" object={inspection ? name(inspection.market) : t("全球市场","Global markets")}
        context={openingObservation ? {observed:openingObservation} : undefined} market={inspection?.market}
        showMapLine={answer?.asOf===openingObservation && !answer?.pricesStale && !query.isError}
        portal={readingSlot}/>
      <header className="mx-global-lead">
        <div className="mx-global-heading">
          <h2 id="mx-global-title">{title}</h2>
          <Help label={title} tag={<Tag tone="warn">{t("估算", "Estimate")}</Tag>}
            basis={<>{t("权重来自 iShares MSCI ACWI UCITS ETF（SSAC）持仓，按所在地汇总", "Weights come from iShares MSCI ACWI UCITS ETF (SSAC) holdings, grouped by location")}
              {answer?.weightsAsOf && <>{t("，持仓截至 ", ", as of ")}{formatCalendarDate(answer.weightsAsOf, locale)}</>}
              {t("。以 MSCI 全球的最近一次收盘划分交易日。", ". The latest MSCI ACWI close separates global sessions.")}</>}>
            <p>{t("已单列的发达市场：权重 × 主要指数的本币涨跌。新兴市场：合计权重 × MSCI EM 的美元涨跌。尚未开盘的市场贡献为零。", "For each listed developed market: weight × local-currency move in its main index. For emerging markets: combined weight × the USD move in MSCI EM. Markets yet to open contribute zero.")}</p>
            <p>{t("汇率与其他 = MSCI 全球涨跌减去已列贡献，包含汇率、未覆盖市场和估算误差。", "Currency and other is the MSCI ACWI move less the listed contributions. It includes currency effects, markets outside the estimate and approximation error.")}</p>
          </Help>
        </div>
        {total != null && <div className="mx-global-move" data-tone={tone(total)}>{change(total)}</div>}
        <p className="mx-global-colour-key">{t("地图颜色：各市场指数的本币涨跌", "Map colours: local index moves")}</p>
      </header>
      <div ref={mapHost} className="mx-global-map" data-testid="global-map">
        <svg viewBox={wide ? WIDE_WORLD_VIEWBOX : WORLD_VIEWBOX} preserveAspectRatio="xMidYMid meet" role="group" aria-label={t("全球市场地图", "World market map")}>
          <path className="mx-global-land" d={WORLD_LAND} fillRule="evenodd" />
          {(Object.entries(MAP) as [MapMarket, Label][]).map(([market, { label, phone, point }]) => {
            const reading = answer?.markets.find((item) => item.market === market);
            const move = reading?.move;
            const row = rows.find((item) => item.market === market);
            // Focusing the EM aggregate outlines all of its mapped markets.
            const selected = active === market || (active === "em" && EM_MARKETS.has(market));
            const style = globalHeatStyle(move);
            return <a key={market} href={presentationLink(pathname, url(market)).href}
              className="mx-global-region" data-market={market} data-neutral={style["--mx-world-heat-light"] === "0%" || undefined} data-linked={selected || undefined}
              aria-label={accessible(market, move, row?.contribution, reading?.notOpen)} style={style}
              aria-expanded={inspection?.market === market}
              aria-controls={inspection?.market === market ? "mx-global-inspection" : undefined}
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
                if ((event.key === "Tab" && !event.shiftKey) && inspection?.market === market) {
                  event.preventDefault();
                  (popover.current?.querySelector<HTMLElement>("button, a") ?? detailLink.current)?.focus();
                }
              }}>
              {market !== "hk" && <path className="mx-global-shape" d={MARKET_PATHS[market]} fillRule="evenodd" />}
              {market !== "hk" && TOUCH_OUTLINE[market] && <path className="mx-global-touch" d={MARKET_PATHS[market]} style={{ strokeWidth: TOUCH_OUTLINE[market] }} />}
              {point && <circle className="mx-global-pin" cx={point[0]} cy={point[1]} r={market === "hk" ? 4.5 : 3.4} />}
              <MapLabel name={name(market)} position={label} point={point} />
              <MapLabel name={name(market)} position={phone} point={point ?? label} phone />
            </a>;
          })}
        </svg>
        {inspection && <div
          ref={popover} id="mx-global-inspection" className="mx-global-inspection"
          style={placement ? { left: placement.x, top: placement.y } : { visibility: "hidden" }}
          onPointerEnter={cancelDismiss} onPointerLeave={() => {
            if (!popover.current?.contains(document.activeElement)) deferDismiss();
          }}
          onFocus={cancelDismiss} onBlur={(event) => {
            if (event.relatedTarget instanceof Element &&
              (event.currentTarget.contains(event.relatedTarget) || event.relatedTarget.matches(".mx-global-region"))) return;
            close();
          }}>
          <div className="mx-global-inspect-head">{name(inspection.market)} · {t(...INDEX_NAMES[MAP_INDEX[inspection.market]])}</div>
          {/* Not open hides the move, flat keeps it in ink, no quote shows none. */}
          <div className="mx-global-inspect-move"
            data-tone={inspectedMove?.move != null && !inspectedMove.notOpen && !inspectedStatus ? tone(inspectedMove.move) : undefined}>
            {inspectedMove?.move == null || inspectedMove.notOpen ? <span data-status="">{inspectedStatus}</span>
              : <>{change(inspectedMove.move)}{inspectedStatus && <span data-status="">{inspectedStatus}</span>}</>}
          </div>
          <dl className="mx-global-inspect-rows">
            <div><dt>{t("贡献", "Contribution")}</dt>
              <dd>{inspectedContribution == null ? contributionText(inspection.market) : pp(inspectedContribution)}</dd></div>
          </dl>
          {ready && <div ref={setReadingSlot}/>}
          <Link ref={detailLink} href={url(inspection.market)} prefetch={false}
            onClick={(event) => open(event, inspection.market)} onKeyDown={(event) => {
              if (event.key !== "Tab" || event.shiftKey && readingSlot?.querySelector("button")) return;
              const regions = Array.from(mapHost.current?.querySelectorAll<MapAnchor>(".mx-global-region") ?? []);
              const source = trigger.current;
              if (!source) return;
              const next = event.shiftKey ? source : regions[regions.indexOf(source) + 1];
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
        {query.isError && !answer ? <QueryError retry={query.refetch} showDataStatusLink={false} />
          : query.isPending ? <Pending label={t("正在加载贡献", "Loading contributions")} compact />
          : !priced ? <div className="mx-global-status" role="status">
            <div><strong>{t("暂无可用的贡献估算", "No contribution estimate available")}</strong>
              <p>{noContribution}</p>
              {answer && <p>{t("本地行情覆盖", "Local quote coverage")} · {coveredMarkets} / {answer.markets.length}
                {answer.asOf && <> · <time dateTime={answer.asOf}>{formatDateTime(answer.asOf, locale, timeZone)}</time></>}</p>}
            </div>
            <button className="mx-index-retry" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {t("重试", "Retry")}
            </button>
          </div> : null}
        {(query.isError && answer || answer?.weightsStale || answer?.pricesStale || answer?.state === "partial") && <div className="mx-global-caveats" role="status">
          {query.isError && answer && <Tag tone="warn">{t("刷新失败", "Refresh failed")}</Tag>}
          {answer?.pricesStale && <Tag tone="warn">{answer.asOf
            ? t("报价未更新 · ", "Quotes haven’t updated · ") + formatDateTime(answer.asOf, locale, timeZone)
            : t("报价暂不可用", "Quotes temporarily unavailable")}</Tag>}
          {answer?.weightsStale && <Tag tone="warn">{t("权重未更新", "Weights haven’t updated")}</Tag>}
          {answer?.state === "partial" && <Tag tone="warn">{t("部分报价不可用", "Partial quote coverage")}</Tag>}
        </div>}
        {priced && <>
          <ul className="mx-global-rows">
            {rows.map(({ market, indexId, move, contribution, notOpen }) => {
              const selected = active === market || (market === "em" && active != null && EM_MARKETS.has(active));
              const index = INDEX_NAMES[indexId];
              const status = quoteStatus(move, notOpen);
              const label = <span className="mx-global-row-label">
                <strong>{name(market)} · {index ? t(...index) : indexId}</strong>
                <small>{notOpen ? preOpen : <><span className="sr-only">{status ? status + t("，", ", ") : ""}{t("涨跌 ", "Move ")}</span>{change(move)}</>}</small>
              </span>;
              const content = <>{label}<ContributionBar value={contribution} limit={limit} /><span className="mx-global-pp"><span className="sr-only">{t("贡献 ", "Contribution ")}</span>{pp(contribution)}</span></>;
              return <li key={market}>
                {market === "em" ? <Link className="mx-global-row" href="/sectors?market=global&index=msci-em" prefetch={false}
                  data-linked={selected || undefined} {...bindings(market)}>{content}</Link>
                : <Link className="mx-global-row" href={url(market)} prefetch={false} data-linked={selected || undefined}
                  onClick={(event) => open(event, market)} {...bindings(market)}>
                  {content}
                </Link>}
              </li>;
            })}
            <li className="mx-global-row mx-global-residual">
              <strong>{t("汇率与其他", "Currency and other")}</strong>
              <ContributionBar value={residual} limit={limit} /><span className="mx-global-pp">{pp(residual)}</span>
            </li>
          </ul>
          <div className="mx-global-total"><strong>{t("合计", "Total")}</strong><strong data-tone={tone(total)}>{change(total)}</strong></div>
        </>}
      </div>
    </section>
  );
}

function MapLabel({ name, position: [x, y], point, phone }: {
  name: string; position: [number, number]; point?: [number, number]; phone?: boolean;
}) {
  const width = phone ? 100 : 50;
  const height = phone ? 100 : 34;
  return <g className={phone ? "mx-global-label-phone" : "mx-global-label-desktop"} aria-hidden="true">
    {point && <path className="mx-global-leader" d={`M${point.join(",")} L${x},${y}`} />}
    <rect className="mx-global-hit" x={x - width / 2} y={y - height / 2} width={width} height={height} rx="4" />
    <text x={x} y={y} textAnchor="middle" dominantBaseline="central">{name}</text>
  </g>;
}

function ContributionBar({ value, limit }: { value: number; limit: number }) {
  return <span className="mx-global-bar" data-tone={tone(value)} aria-hidden="true">
    <i style={{ width: `${Math.abs(value) / limit * 100}%` }} />
  </span>;
}
