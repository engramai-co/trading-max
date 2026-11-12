"use client";

import { usePathname } from "next/navigation";
import { useState, type MouseEvent } from "react";
import type { components } from "@/lib/api-schema";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDeltaPercent, formatNumber } from "@/ui/formatters";
import { presentationLink } from "./desktop-routing";
import { Empty, Help, Pending, QueryError, Tag, useCopy } from "./foundation";
import { globalHeatStyle, useGlobalContribution } from "./global-markets-data";
import { MARKET_PATHS, WORLD_LAND, WORLD_VIEWBOX } from "./global-market-geometry";
import Link from "./link";

type MapMarket = components["schemas"]["GlobalMarketMove"]["market"];
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
  jp: { name: ["日本", "Japan"], label: [718, 68], point: [671, 101], phone: [713, 37] },
  kr: { name: ["韩国", "Korea"], label: [727, 109], point: [650, 101], phone: [713, 130] },
  hk: { name: ["香港", "Hong Kong"], label: [719, 156], point: [637, 138], phone: [713, 223] },
  tw: { name: ["台湾", "Taiwan"], label: [720, 202], point: [654, 139], phone: [713, 316] },
  in: { name: ["印度", "India"], label: [558, 142], phone: [574, 158] },
  au: { name: ["澳洲", "Australia"], label: [683, 279], phone: [596, 280] },
};

const INDEX_NAMES: Record<string, [string, string]> = {
  "sp-500": ["标普 500", "S&P 500"],
  "sp-tsx": ["TSX", "TSX"],
  "ftse-100": ["富时 100", "FTSE 100"],
  "euro-stoxx-50": ["欧洲斯托克 50", "EURO STOXX 50"],
  "stoxx-europe-600": ["STOXX 600", "STOXX 600"],
  "smi": ["SMI", "SMI"],
  "nikkei-225": ["日经 225", "Nikkei 225"],
  "asx-200": ["ASX 200", "ASX 200"],
  "hang-seng": ["恒生指数", "Hang Seng"],
  "msci-em": ["MSCI EM", "MSCI EM"],
};

function tone(value: number) {
  return value < 0 ? "down" : value > 0 ? "up" : "flat";
}

export function GlobalMarkets({ demo, onMarket }: { demo: boolean; onMarket: (market: MapMarket) => void }) {
  const t = useCopy();
  const { locale } = useLocale();
  const pathname = usePathname();
  const [hovered, setHovered] = useState<Market | null>(null);
  const [focused, setFocused] = useState<Market | null>(null);
  const active = hovered ?? focused;
  const title = t("对 MSCI 全球的贡献", "Contribution to MSCI ACWI");
  const query = useGlobalContribution(!demo);
  const answer = query.data;
  const change = (value: number | null | undefined) => formatDeltaPercent(value, locale, 2);
  const pp = (value: number) => formatNumber(value * 100, locale, {
    minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero",
  }) + " pp";
  const name = (market: Market) => market === "em" ? t("新兴市场", "Emerging markets") : t(...MAP[market].name);
  const preOpen = t("未开盘", "Not open");
  const accessible = (market: Market, move?: number | null, contribution?: number, notOpen = false) => {
    const parts = [name(market), notOpen ? preOpen : t("涨跌 ", "Move ") + change(move), t("贡献 ", "Contribution ") +
      (contribution == null ? t("未单列", "not shown separately") : pp(contribution))];
    return parts.join(t("，", ", "));
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
  const priced = total != null && residual != null;
  return (
    <div className="mx-global-panel">
      <div className="mx-global-map" data-testid="global-map">
        <svg viewBox={WORLD_VIEWBOX} preserveAspectRatio="none" role="group" aria-label={t("全球市场地图", "World market map")}>
          <path className="mx-global-land" d={WORLD_LAND} fillRule="evenodd" />
          {(Object.entries(MAP) as [MapMarket, Label][]).map(([market, { label, phone, point }]) => {
            const reading = answer?.markets.find((item) => item.market === market);
            const move = reading?.move;
            const row = rows.find((item) => item.market === market);
            // EM is an aggregate, so its three markets share a row but only an individually
            // pointed market gets a border. Focusing the aggregate outlines all three.
            const selected = active === market || (active === "em" && ["kr", "tw", "in"].includes(market));
            const style = globalHeatStyle(move);
            return <a key={market} href={presentationLink(pathname, url(market)).href}
              className="mx-global-region" data-market={market} data-neutral={style["--mx-world-heat-light"] === "0%" || undefined} data-linked={selected || undefined}
              aria-label={accessible(market, move, row?.contribution, reading?.notOpen)} style={style}
              onClick={(event) => open(event, market)} {...bindings(market)}>
              {market !== "hk" && <path className="mx-global-shape" d={MARKET_PATHS[market]} fillRule="evenodd" />}
              {point && <circle className="mx-global-pin" cx={point[0]} cy={point[1]} r={market === "hk" ? 4.5 : 3.4} />}
              <MapLabel name={name(market)} position={label} point={point} />
              <MapLabel name={name(market)} position={phone} point={point ?? label} phone />
            </a>;
          })}
        </svg>
      </div>
      <section className="mx-global-ranking" aria-labelledby="mx-global-title">
        <div className="mx-global-heading">
          <h2 id="mx-global-title">{title}</h2>
          <Help label={title} tag={<Tag>{t("估算", "Estimate")}</Tag>}>
            <p>{t("权重来自 iShares MSCI ACWI UCITS ETF（SSAC）持仓，按所在地汇总。", "Weights come from iShares MSCI ACWI UCITS ETF (SSAC) holdings, grouped by location.")}
              {answer?.weightsAsOf && <> {t("持仓截至 ", "Holdings as of ")}{formatCalendarDate(answer.weightsAsOf, locale)}.</>}
            </p>
            <p>{t("已单列的发达市场：权重 × 主要指数的本币涨跌。新兴市场：合计权重 × MSCI EM 的美元涨跌。以 MSCI 全球的最近一次收盘划分交易日。新一轮尚未开盘的市场贡献为零。", "For each listed developed market: weight × local-currency move in its main index. For emerging markets: combined weight × the USD move in MSCI EM. The latest MSCI ACWI close separates global sessions. Markets yet to open in the current session contribute zero.")}</p>
            <p>{t("汇率与其他 = MSCI 全球涨跌减去已列贡献，包含汇率、未覆盖市场和估算误差。", "Currency and other is the MSCI ACWI move less the listed contributions. It includes currency effects, markets outside the estimate and approximation error.")}</p>
          </Help>
        </div>
        {total != null && <div className="mx-global-move" data-tone={tone(total)}>{change(total)}</div>}
        {query.isError && !answer ? <QueryError retry={query.refetch} showDataStatusLink={false} />
          : query.isPending ? <Pending label={t("正在加载贡献", "Loading contributions")} compact />
          : !priced ? <div className="mx-global-status" role="status">
            {t("暂无可用的贡献估算", "No contribution estimate available")}
            <button className="mx-index-retry" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {t("重试", "Retry")}
            </button>
          </div> : null}
        {(query.isError && answer || answer?.weightsStale || answer?.state === "partial") && <div className="mx-global-caveats" role="status">
          {query.isError && answer && <Tag tone="warn">{t("刷新失败", "Refresh failed")}</Tag>}
          {answer?.weightsStale && <Tag tone="warn">{t("权重未更新", "Weights haven’t updated")}</Tag>}
          {answer?.state === "partial" && <Tag tone="warn">{t("部分报价不可用", "Partial quote coverage")}</Tag>}
        </div>}
        {priced && <>
          <ul className="mx-global-rows">
            {rows.map(({ market, indexId, move, contribution, notOpen }) => {
              const selected = active === market || (market === "em" && active != null && ["kr", "tw", "in"].includes(active));
              const index = INDEX_NAMES[indexId];
              const label = <span className="mx-global-row-label">
                <strong>{name(market)} · {index ? t(...index) : indexId}</strong><small>{notOpen ? preOpen : change(move)}</small>
              </span>;
              const content = <>{label}<ContributionBar value={contribution} limit={limit} /><span className="mx-global-pp">{pp(contribution)}</span></>;
              return <li key={market}>
                {market === "em" ? <Link className="mx-global-row" href="/sectors?market=global&index=msci-em" prefetch={false}
                  data-linked={selected || undefined} {...bindings(market)} aria-label={accessible(market, move, contribution, notOpen)}>{content}</Link>
                : <Link className="mx-global-row" href={url(market)} prefetch={false} data-linked={selected || undefined}
                  onClick={(event) => open(event, market)} aria-label={accessible(market, move, contribution, notOpen)} {...bindings(market)}>
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
      </section>
    </div>
  );
}

function MapLabel({ name, position: [x, y], point, phone }: {
  name: string; position: [number, number]; point?: [number, number]; phone?: boolean;
}) {
  const width = phone ? 116 : 50;
  const height = phone ? 92 : 34;
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
