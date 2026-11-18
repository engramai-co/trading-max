"use client";

import { ActionIcon, Button, Drawer, Menu, Select } from "@mantine/core";
import { CaretDown, DotsThree, Trash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type CSSProperties } from "react";
import { quoteUnit, quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import { researchShellKey } from "@/lib/dashboard-query";
import type { ResearchShell } from "@/lib/types";
import { formatCalendarDate, formatCurrency, formatDateTime, formatDeltaPercent, formatNumber, formatPercent } from "@/ui/formatters";
import { api, readApi, safeUrl } from "./data";
import { useDemonstration } from "./demonstration";
import { EvidenceTable } from "./evidence-table";
import { Empty, Facts, Help, Page, Panel, Pending, QueryError, Tabs, tabId, useCopy } from "./foundation";
import Link from "./link";
import {
  indexHref, researchIndexHref, useIndexCatalog,
  type IndexComposition, type IndexConstituent, type IndexIdentity, type IndexProduct, type IndexResearch,
} from "./market-indices-data";
import { useListedIndices } from "./listed-indices";
import { ResearchIndexChart } from "./research-index-chart";
import { SecurityFinder } from "./research-finder";
import { TechnicalScoreCard } from "./research-technical";
import { UniverseHeading, UniverseList, useResearchUniverse } from "./research-universe";
import { useRouteState } from "./route-state";

const views = ["overview", "price", "constituents", "tracking"] as const;
type Copy = ReturnType<typeof useCopy>;

function variantLabel(index: IndexIdentity, t: Copy) {
  if (index.kind === "etf-price") return t("ETF 市价", "ETF market price");
  if (index.kind === "volatility") return t("隐含波动率", "Implied volatility");
  return ({
    PR: t("价格指数", "Price return"),
    NR: t("净回报", "Net return"),
    GR: t("总回报", "Gross total return"),
    TR: t("总回报 · 税务口径未核实", "Total return · tax basis unverified"),
  })[index.variant ?? "PR"];
}

export function IndexResearchWorkspace() {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const demonstration = useDemonstration();
  const { params, update } = useRouteState("push");
  const [finder, setFinder] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const lensPanel = useId();
  const catalog = useIndexCatalog();
  const catalogue = catalog.data ?? [];
  const id = params.get("index") ?? "";
  const index = catalogue.find((item) => item.id === id);
  const shell = useQuery({
    queryKey: researchShellKey,
    queryFn: ({ signal }) => readApi<ResearchShell>("/research/shell", signal),
    enabled: listOpen,
    retry: 0,
  });
  const instruments = shell.data?.instruments ?? [];
  const universe = useResearchUniverse(instruments);
  const view = views.find((value) => value === params.get("view")) ?? "overview";
  const overview = useQuery({
    queryKey: ["index-research", id, "overview"],
    queryFn: ({ signal }) => api<IndexResearch>(`/indices/${id}/research?view=overview`, { signal }),
    enabled: Boolean(index && !demonstration),
    staleTime: 60_000,
    retry: 0,
  });
  const selected = useQuery({
    queryKey: ["index-research", id, view],
    queryFn: ({ signal }) => api<IndexResearch>(`/indices/${id}/research?view=${view}`, { signal }),
    enabled: Boolean(index && (view === "tracking" || view === "constituents") && !demonstration),
    staleTime: 60_000,
    retry: 0,
  });
  const quote = overview.data?.quote;
  const tabLabels = {
    overview: { label: t("概览", "Overview"), short: t("概览", "Overview") },
    price: { label: t("价格与走势", "Price & trend"), short: t("走势", "Price") },
    constituents: { label: t("成分与权重", "Constituents & weights"), short: t("成分", "Members") },
    tracking: { label: t("跟踪产品", "Tracking products"), short: t("跟踪产品", "Products") },
  };
  const name = index ? t(index.nameZh, index.name) : "";
  const openTicker = (ticker: string) => {
    setListOpen(false);
    update({ type: null, index: null, view: null, ticker });
  };
  return (
    <Page title={t("研究", "Research")} titleHidden className="mx-research-page mx-index-research" actions={
      <>
        {!index && <Button className="mx-universe-toggle" variant="default" rightSection={<CaretDown size={14} />}
          aria-expanded={listOpen} onClick={() => setListOpen(true)}>
          {t("研究清单", "Research list")}
        </Button>}
        {index && <IndexListActions id={index.id} />}
      </>
    }>
      {catalog.isPending ? <Pending shape="research" quiet /> : catalog.isError
        ? <QueryError retry={catalog.refetch} /> : !index
          ? <Panel><Empty title={t("未找到此指数", "Index not found")} /></Panel> : <>
            <section className="mx-panel mx-index-research-hero">
              <div>
                <h2>
                  <button type="button" className="mx-security-switcher"
                    aria-label={name + t("，打开研究清单", ", open research list")}
                    aria-expanded={listOpen} onClick={() => setListOpen(true)}>
                    {name}
                    <CaretDown size={16} aria-hidden="true" />
                  </button>
                </h2>
                <div className="mx-index-research-basis">
                  <span>{[index.compiler, variantLabel(index, t), index.kind === "etf-price" ? quoteUnit(index.currency).currency : index.currency].filter(Boolean).join(" · ")}</span>
                </div>
              </div>
              {quote?.level != null ? <div className="mx-index-research-level">
                <strong>{index.kind === "etf-price" ? quoteValue(quote.level, index.currency, { style: "number" }) : formatNumber(quote.level, locale, { maximumFractionDigits: 2 })}</strong>
                {quote.change != null && <span className={quote.change > 0 ? "mx-up" : quote.change < 0 ? "mx-down" : ""}>
                  {index.kind === "volatility" ? formatNumber(quote.change, locale, { signDisplay: "exceptZero", maximumFractionDigits: 2 }) : formatDeltaPercent(quote.change, locale, 2)}
                </span>}
                {quote.asOf && <small className={quote.state === "stale" ? "mx-index-research-caveat" : undefined}>
                  {quote.state === "stale" ? t("未更新", "Stale") + " · " : ""}
                  {quote.state === "observed" && quote.sessionDate
                    ? formatCalendarDate(quote.sessionDate, locale)
                    : formatDateTime(quote.asOf, locale, timeZone)}
                </small>}
              </div> : !overview.isPending || demonstration ? <span>{t("无报价", "No quote")}</span> : null}
            </section>
            <Tabs label={t("研究视角", "Research perspectives")} value={view}
              activation="manual" panel={lensPanel}
              options={views.map((value) => ({ value, ...tabLabels[value] }))}
              onChange={(next) => update({ view: next === "overview" ? null : next })} />
            <div className="mx-index-research-body" role="tabpanel" id={lensPanel} aria-labelledby={tabId(lensPanel, view)}>
              {view === "price" ? <ResearchIndexChart key={index.id} index={index} catalogue={catalogue} demonstration={demonstration} />
                : view === "overview" ? <>
                  <ResearchIndexChart key={index.id} index={index} catalogue={catalogue} preview demonstration={demonstration} />
                  {overview.isError ? <QueryError retry={overview.refetch} /> : overview.data
                    ? <IndexOverview index={index} data={overview.data} /> : null}
                </> : selected.isPending && !demonstration ? <Pending shape="research" quiet />
                  : selected.isError ? <QueryError retry={selected.refetch} />
                    : view === "constituents" ? <IndexMembers index={index} basket={selected.data?.composition} />
                      : <TrackingProducts products={selected.data?.products ?? []} />}
            </div>
            <Link className="mx-text-link mx-index-research-market" href={indexHref(index)}>
              {t("在市场页查看", "Open in Markets")}
            </Link>
          </>}
      <SecurityFinder opened={finder} onClose={() => setFinder(false)} initial="" onSelect={(security) => {
        update({ type: null, index: null, view: null, ticker: security.ticker });
        setFinder(false);
      }} />
      <Drawer
        opened={listOpen}
        onClose={() => setListOpen(false)}
        title={<UniverseHeading wide={false} pinned={false} onPin={() => undefined}
          onSearch={() => { setListOpen(false); setFinder(true); }} />}
        styles={{ title: { flex: 1 }, header: { gap: 8 } }}
        size={360}
      >
        {shell.isError ? <QueryError retry={shell.refetch} /> : <UniverseList
          state={universe}
          categories={shell.data?.watchlistCategories ?? []}
          instruments={instruments}
          ticker=""
          indexId={id}
          onSelect={openTicker}
        />}
      </Drawer>
    </Page>
  );
}

/** The same list action as a stock or fund: add it, or remove it from the ··· menu. */
function IndexListActions({ id }: { id: string }) {
  const t = useCopy();
  const listed = useListedIndices();
  return (
    <div className="mx-research-actions">
      {listed.has(id) ? <Menu shadow="md" position="bottom-end">
        <Menu.Target>
          <ActionIcon aria-label={t("更多操作", "More actions")}>
            <DotsThree size={23} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item color="red" leftSection={<Trash size={15} />} onClick={() => listed.remove(id)}>
            {t("从研究清单移除", "Remove from research list")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu> : <Button onClick={() => listed.add(id)}>{t("加入研究清单", "Add to research list")}</Button>}
    </div>
  );
}

function IndexOverview({ index, data }: { index: IndexIdentity; data: IndexResearch }) {
  const t = useCopy();
  const { locale } = useLocale();
  const basket = data.composition;
  return <>
    {(data.technical || basket || data.valuation || data.exposure) && <Panel title={t("指数概况", "Index overview")}>
      <div className="mx-index-research-overview">
        {data.technical && <TechnicalScoreCard data={data.technical} compact />}
        <Facts rows={[
          ...(basket?.up != null ? [[t("涨 / 平 / 跌 / 未覆盖", "Up / Flat / Down / Uncovered"),
            [basket.up, basket.flat, basket.down, basket.uncovered].map((value) => value ?? "—").join(" / ")]] as const : []),
          ...(data.valuation?.pe != null ? [[t("市盈率", "P/E"),
            formatNumber(data.valuation.pe, locale, { maximumFractionDigits: 1 }) + " · " + data.valuation.source]] as const : []),
          ...(data.exposure ? [[t("我的合计敞口", "My combined exposure"),
            <span key="my-exposure">{formatCurrency(data.exposure.totalGbp, locale, "GBP")}
              <Help label={t("我的敞口口径", "My exposure basis")}>
                <p>{(data.exposure.matchedIsins === 1
                  ? t("按成分 ISIN 合并直接持股与基金穿透。已匹配到 {count} 个 ISIN。", "Direct and fund look-through holdings are folded by constituent ISIN. {count} ISIN matched.")
                  : t("按成分 ISIN 合并直接持股与基金穿透。已匹配到 {count} 个 ISIN。", "Direct and fund look-through holdings are folded by constituent ISIN. {count} ISINs matched.")
                ).replace("{count}", String(data.exposure.matchedIsins))}</p>
                <p>{t("直接", "Direct")} {formatCurrency(data.exposure.directGbp, locale, "GBP")} · {t("穿透", "Look-through")} {formatCurrency(data.exposure.lookThroughGbp, locale, "GBP")}</p>
                <p>{formatCalendarDate(data.exposure.asOf, locale)}</p>
              </Help>
            </span>]] as const : []),
        ].map(([label, value]) => [label, value])} />
      </div>
    </Panel>}
    {!!data.products?.length && <Panel title={t("跟踪产品", "Tracking products")} action={
      <Link className="mx-text-link" href={researchIndexHref(index, "tracking")}>{t("查看全部", "View all")}</Link>
    }>
      <ProductRows products={data.products.slice(0, 3)} simple />
    </Panel>}
  </>;
}

function relation(value: IndexProduct["relationship"], t: Copy) {
  return ({
    exact: t("同基准", "Same benchmark"),
    "same-family-other-variant": t("同系列，口径不同", "Same family, different basis"),
    "similar-exposure": t("相似敞口", "Similar exposure"),
    "related-different-structure": t("相关但结构不同", "Related, different structure"),
    unconfirmed: t("对冲口径未确认", "Hedged comparison unconfirmed"),
  })[value];
}

function ProductRows({ products, simple = false }: { products: IndexProduct[]; simple?: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  return <ul className="mx-index-research-products">
    {products.map((fund) => <li key={fund.isin}>
      <div>
        <Link className="mx-text-link" href={`/research?ticker=${encodeURIComponent(fund.ticker)}`}>{fund.ticker}</Link>
        <span>{fund.name !== fund.ticker ? fund.name : ""}</span>
        {!simple && <small>{[fund.domicile, fund.shareCurrency, fund.hedged ? t("对冲", "Hedged") : t("未对冲", "Unhedged"),
          fund.replication, fund.incomeUse].filter(Boolean).join(" · ")}</small>}
      </div>
      <div>
        <span>{relation(fund.relationship, t)}</span>
        {fund.valueGbp != null && <strong>{formatCurrency(fund.valueGbp, locale, "GBP")}</strong>}
        {!simple && (fund.expenseRatio != null || fund.size != null || fund.trackingDifference != null) && <small>
          {[
            fund.expenseRatio != null ? `TER ${formatPercent(fund.expenseRatio, locale, 2)}` : null,
            fund.size != null && fund.sizeCurrency ? [fund.sizeBasis === "share-class" ? t("份额类别资产", "Share-class assets") : t("基金资产", "Fund assets"),
              formatCurrency(fund.size, locale, fund.sizeCurrency, 0)].join(" ") : null,
            fund.trackingDifference != null ? [t("年化跟踪差", "Annualised tracking difference"), formatDeltaPercent(fund.trackingDifference, locale, 2)].join(" ") : null,
          ].filter(Boolean).join(" · ")}
        </small>}
        {!simple && safeUrl(fund.evidenceUrl) && <a className="mx-text-link" href={fund.evidenceUrl} target="_blank" rel="noreferrer">{t("发行商", "Issuer")} · {formatCalendarDate(fund.evidenceDate, locale)}</a>}
      </div>
    </li>)}
  </ul>;
}

function TrackingProducts({ products }: { products: IndexProduct[] }) {
  const t = useCopy();
  const groups: { key: IndexProduct["group"]; label: string }[] = [
    { key: "held", label: t("我持有", "I hold") },
    { key: "same-benchmark", label: t("同基准", "Same benchmark") },
    { key: "same-family", label: t("同系列，口径不同", "Same family, different basis") },
    { key: "similar", label: t("相似敞口", "Similar exposure") },
    { key: "related", label: t("相关但结构不同", "Related, different structure") },
  ];
  return <Panel title={t("跟踪产品", "Tracking products")}>
    {groups.map(({ key, label }) => {
      const matching = products.filter((fund) => fund.group === key);
      if (!matching.length && key !== "same-benchmark") return null;
      return <section key={key} className="mx-index-research-product-group" aria-label={label}>
        <h3>{label}</h3>
        {matching.length ? <ProductRows products={matching} /> : <p className="mx-form-help">{
          products.some((fund) => fund.group === "held" && fund.relationship === "exact")
            ? t("尚无其他已核实基金", "No other verified funds yet") : t("尚无已核实基金", "No verified funds yet")
        }</p>}
      </section>;
    })}
  </Panel>;
}

function IndexMembers({ index, basket }: { index: IndexIdentity; basket?: IndexComposition | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  const [sort, setSort] = useState("weight");
  const rows = [...(basket?.members ?? [])].sort((a, b) => sort === "name"
    ? a.ticker.localeCompare(b.ticker) : sort === "move" ? (b.move ?? -Infinity) - (a.move ?? -Infinity) : b.weight - a.weight);
  const raw = basket?.members ?? [];
  const concentration = raw.slice(0, 10).reduce((sum, row) => sum + row.weight, 0);
  const weight = raw.reduce((sum, row) => sum + row.weight, 0);
  const effective = raw.length ? weight ** 2 / raw.reduce((sum, row) => sum + row.weight ** 2, 0) : undefined;
  return <>
    <Panel title={t("成分与权重", "Constituents & weights")} action={basket && <Select size="xs"
      aria-label={t("成分排序", "Sort constituents")} value={sort} onChange={(next) => setSort(next ?? "weight")}
      data={[{ value: "weight", label: t("按权重", "By weight") }, { value: "move", label: t("按涨跌", "By move") }, { value: "name", label: t("按代码", "By ticker") }]} />}>
      {!basket ? <Empty title={index.id === "nikkei-225"
        ? t("日经 225 按价格加权，暂无已验证权重。", "Nikkei 225 is price weighted. Verified weights are unavailable.")
        : t("暂无已确认的成分篮子", "No verified constituent basket")} /> : <>
        <div className="mx-index-research-provenance">
          {basket.sourceUrl && safeUrl(basket.sourceUrl)
            ? <a className="mx-text-link" href={basket.sourceUrl} target="_blank" rel="noreferrer">{basket.source}</a> : basket.source}
          <span>{basket.basketBasis === "market-proxy" ? t("市场代理篮子", "Market proxy basket")
            : basket.basketBasis === "official" ? t("官方价格权重", "Official price weights") : t("发行商组合", "Issuer basket")}</span>
          <time dateTime={basket.holdingsDate}>{formatCalendarDate(basket.holdingsDate, locale)}</time>
          {basket.sessionDate && basket.sessionDate !== basket.holdingsDate &&
            <span>{t("行情", "Quotes")} {formatCalendarDate(basket.sessionDate, locale)}</span>}
          {basket.coverage != null && <span>{t("行情覆盖", "Price coverage")} {formatPercent(basket.coverage, locale, 1)}</span>}
        </div>
        <Facts rows={[
          [t("成分数", "Constituents"), rows.length],
          [t("前十权重", "Top-ten weight"), formatPercent(concentration, locale, 1)],
          [t("有效成分数", "Effective constituents"), formatNumber(effective, locale, { maximumFractionDigits: 1 })],
        ]} />
        {rows.length > 0 && <Heatmap rows={raw} />}
        <EvidenceTable label={t("成分权重", "Constituent weights")} rows={rows} columns={[
          { label: t("名称", "Name"), value: (row) => <Link className="mx-text-link" href={`/research?ticker=${encodeURIComponent(row.ticker)}`}>
            {row.ticker}{row.ticker !== row.name ? " · " + row.name : ""}
          </Link> },
          { label: t("权重", "Weight"), numeric: true, value: (row) => formatPercent(row.weight, locale, 2) },
          { label: t("涨跌", "Move"), numeric: true, value: (row) => formatDeltaPercent(row.move, locale, 2) },
          { label: t("板块 · 国家/地区", "Sector · Country"), value: (row) => [row.industry, row.country].filter(Boolean).join(" · ") || "—" },
        ]} />
      </>}
    </Panel>
    {basket && (basket.up != null || basket.waterfall?.length) && <IndexBreadth basket={basket} />}
  </>;
}

type Rect = { x: number; y: number; w: number; h: number };
function treemap(items: IndexConstituent[], rect: Rect): { row: IndexConstituent; rect: Rect }[] {
  if (items.length <= 1) return items.map((row) => ({ row, rect }));
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = 1, first = items[0].weight;
  while (cursor < items.length - 1 && first + items[cursor].weight < total / 2) first += items[cursor++].weight;
  const split = first / total;
  const { x, y, w, h } = rect;
  const horizontal = w > h;
  return [
    ...treemap(items.slice(0, cursor), { x, y, w: horizontal ? w * split : w, h: horizontal ? h : h * split }),
    ...treemap(items.slice(cursor), { x: horizontal ? x + w * split : x, y: horizontal ? y : y + h * split,
      w: horizontal ? w * (1 - split) : w, h: horizontal ? h : h * (1 - split) }),
  ];
}

function Heatmap({ rows }: { rows: IndexConstituent[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  const tiles = treemap(rows.filter((row) => row.weight > 0), { x: 0, y: 0, w: 100, h: 100 });
  return <figure aria-label={t("成分热图", "Constituent heatmap")} className="mx-index-research-heatmap">
    {tiles.map(({ row, rect }) => {
      const move = row.move ?? 0;
      const reading = [row.ticker, formatPercent(row.weight, locale, 2), formatDeltaPercent(row.move, locale, 2)].join(" · ");
      return <div key={row.isin ?? row.ticker} title={reading} aria-hidden="true"
        data-tone={move > 0 ? "up" : move < 0 ? "down" : "none"}
        style={{ left: rect.x + "%", top: rect.y + "%", width: rect.w + "%", height: rect.h + "%",
          "--mx-heat-blend": (Math.min(1, Math.abs(move) / 0.03) * 30).toFixed(1) + "%" } as CSSProperties}>
        {rect.w >= 13 && rect.h >= 12 && <><strong>{row.ticker}</strong><span>{formatDeltaPercent(row.move, locale, 1)}</span></>}
      </div>;
    })}
  </figure>;
}

function IndexBreadth({ basket }: { basket: IndexComposition }) {
  const t = useCopy();
  const { locale } = useLocale();
  const flow = basket.waterfall ?? [];
  const positions = flow.map((row, index) => {
    const start = flow.slice(0, index).reduce((sum, entry) => sum + (entry.contribution ?? 0), 0);
    return { ...row, start, end: start + (row.contribution ?? 0) };
  });
  const total = positions.at(-1)?.end ?? 0;
  const lo = Math.min(0, ...positions.map((row) => row.end));
  const hi = Math.max(0, ...positions.map((row) => row.end));
  const x = (value: number) => hi === lo ? 50 : 100 * (value - lo) / (hi - lo);
  return <Panel title={t("宽度与贡献", "Breadth & contribution")} help={t(
    "指数和成分来自同一交易时段才计算残差。缺价权重不归入其他成分。52 周新高新低按当前篮子和可用日线计算。",
    "A residual requires the same index and constituent session. Other constituents exclude missing quotes. New 52-week highs and lows use the current basket and eligible daily history.",
  )}>
    <Facts rows={[
      [t("涨 / 平 / 跌 / 未覆盖", "Up / Flat / Down / Uncovered"), [basket.up, basket.flat, basket.down, basket.uncovered].map((n) => n ?? "—").join(" / ")],
      [t("净新高 · 52 周", "Net new highs · 52 weeks"), basket.highs52w != null && basket.lows52w != null
        ? `${basket.highs52w - basket.lows52w} · ${basket.eligible52w ?? 0}/${basket.members?.length ?? 0}` : "—"],
      [basket.weighting === "price" ? t("等权 / 价格加权", "Equal weight / price weight")
        : t("等权 / 市值权重代理", "Equal weight / cap-weight proxy"),
        [basket.equalWeightMove, basket.priceWeightMove ?? basket.capWeightMove].map((n) => formatDeltaPercent(n, locale, 2)).join(" / ")],
    ]} />
    {positions.length > 0 && <div className="mx-index-research-waterfall" role="list" aria-label={t("贡献瀑布", "Contribution waterfall")}>
      {positions.map((row) => <div key={row.key} role="listitem">
        <span>{row.key === "rest" ? t("其余已覆盖成分", "Other covered constituents") : row.key === "residual" ? t("对账残差", "Reconciliation residual") : row.key}</span>
        <span className="mx-index-research-waterfall-axis" aria-hidden="true">
          <i style={{ left: x(0) + "%" }} />
          <b data-tone={(row.contribution ?? 0) >= 0 ? "up" : "down"} style={{
            left: Math.min(x(row.start), x(row.end)) + "%", width: Math.abs(x(row.end) - x(row.start)) + "%",
          }} />
        </span>
        <strong>{formatDeltaPercent(row.contribution, locale, 2)}</strong>
      </div>)}
      <div role="listitem"><strong>{basket.totalMove != null ? t("指数涨跌", "Index move") : t("已覆盖贡献", "Covered contribution")}</strong>
        <span /><strong>{formatDeltaPercent(basket.totalMove ?? total, locale, 2)}</strong></div>
    </div>}
  </Panel>;
}
