"use client";

import type { components } from "@/lib/api-schema";
import type { ResearchLensSnapshot } from "@/lib/types";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { currency, number, percent, safeUrl } from "@/workspace/data";
import { api, object, str } from "./data";
import {
  etfPortfolioQuery, fieldEvidence, findETF, overlapDisplay, signedPoints, trackingDisplay,
  type Copy, type ETFReading, type FundEvidence,
} from "./etf-data";
import { EvidenceReading } from "./etf-reading";
import { EvidenceTable } from "./evidence-table";
import { Empty, Facts, Help, Panel, Pending, QueryError, Tag, UpdateFailure, useCopy } from "./foundation";
import Link from "./link";
import { indexHref } from "./market-indices-data";
import { researchPriceQuery } from "./research-queries";

type Fund = components["schemas"]["FundResearch"];
type Holding = components["schemas"]["FundHolding"];
type FundSize = components["schemas"]["FundSize"];
type FundMode = "overview" | "tracking" | "holdings" | "peers";

export function fundQuery(ticker: string, runId: string, detail: "profile" | "full" | "journal" = "full") {
  return queryOptions({
    queryKey: ["research-fund", ticker, runId, detail],
    queryFn: ({ signal }) => api<Fund>(
      `/research/${encodeURIComponent(ticker)}/fund?runId=${encodeURIComponent(runId)}&detail=${detail}`, { signal },
    ),
    staleTime: 60_000,
    retry: false,
  });
}

const absent = (t: Copy) => t("暂无", "Unavailable");
const formatSize = (size?: FundSize | null) => size ? currency(size.amount, size.currency, 0) : null;
const income = (value: string | null | undefined, t: Copy) => value === "Accumulating"
  ? t("累积", "Accumulating") : value === "Distributing" ? t("派息", "Distributing") : value ?? absent(t);
const hedge = (value: string | null | undefined, t: Copy) => value === "unhedged"
  ? t("未对冲", "Unhedged") : value ? value + t(" 对冲", " hedged") : absent(t);

function SourceValue({ label, value, evidence, t }: { label: string; value: string; evidence?: FundEvidence; t: Copy }) {
  const description = fieldEvidence(label, value, evidence, t);
  return <span role="group" aria-label={description} title={description}>{value}</span>;
}

function sourceLink(source: string | null | undefined, label: string) {
  return source && safeUrl(source) ? <a className="mx-text-link" href={source} target="_blank" rel="noreferrer">{label} ↗</a> : undefined;
}

function fundReading(fund: Fund): ETFReading {
  return fund.reading ?? {
    tickers: [fund.ticker], issuer: fund.issuer, indexName: fund.indexName,
    holdingsState: "no-holdings", tracking: fund.oneYearTracking ?? { state: "missing" },
    overlap: { state: "missing", datesValid: false },
  };
}

export function FundWorkbench({ data, mode, onExplore, isin }: {
  data: ResearchLensSnapshot; mode: FundMode; onExplore: (ticker: string) => void; isin?: string | null;
}) {
  if (mode === "peers") return <FundPeers data={data} isin={isin} />;
  return <FundIssuerLens data={data} mode={mode} onExplore={onExplore} />;
}

function FundIssuerLens({ data, mode, onExplore }: {
  data: ResearchLensSnapshot; mode: Exclude<FundMode, "peers">; onExplore: (ticker: string) => void;
}) {
  const t = useCopy();
  const query = useQuery(fundQuery(data.ticker, data.runId, mode === "holdings" ? "full" : "profile"));
  if (query.isPending || query.data?.state === "pending") return <Pending shape="holdings" label={t("正在读取基金…", "Loading fund…")} />;
  if (!query.data) return <QueryError retry={query.refetch} />;
  const fund = query.data;
  return <>
    {query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}
    {mode === "overview" ? <FundOverview fund={fund} data={data} />
      : mode === "tracking" ? <FundTracking fund={fund} />
        : <FundHoldings fund={fund} onExplore={onExplore} />}
  </>;
}

function FundOverview({ fund, data }: { fund: Fund; data: ResearchLensSnapshot }) {
  const t = useCopy(), reading = fundReading(fund);
  const { profile } = fund;
  const facts = profile?.evidence;
  const overlap = overlapDisplay(reading, t);
  const fee = fund.expenseRatio == null ? absent(t) : percent(fund.expenseRatio, false, 2);
  const feeName = profile?.feeBasis === "OCF" ? t("持续费用率", "Ongoing charge") : t("总费用率", "Total expense ratio");
  const source = t("发行商原文", "Issuer source");
  const metrics = object(object(data.fundamentals).metrics);
  const matchingListing = profile?.listings?.find((item) => item.ticker === data.ticker);
  return (
    <Panel title={t("基金概况", "Fund profile")} action={sourceLink(fund.sourceUrl, source)}>
      <dl className="mx-etf-summary">
        <div><dt>{t("跟踪质量", "Tracking quality")}</dt><dd><EvidenceReading {...trackingDisplay(reading, t)} /></dd></div>
        <div><dt>{t("交易摩擦", "Trading costs")}</dt><dd>
          <SourceValue label={feeName} value={fee} evidence={facts?.expense_ratio} t={t} />
          <Help label={t("交易摩擦口径", "Trading costs basis")}>
            {feeName}{t("。价差与折溢价没有可用授权数据。", ". Licensed spread and premium or discount data are unavailable.")}
          </Help>
        </dd></div>
        <div><dt>{t("组合重叠", "Portfolio overlap")}</dt><dd>
          <EvidenceReading {...overlap} />
          <Help label={t("重叠覆盖率", "Overlap coverage")}>{overlap.description}</Help>
        </dd></div>
      </dl>
      <Facts rows={[
        [t("跟踪指数", "Tracked index"), fund.indexName ?? absent(t)],
        ["ISIN", fund.isin ?? absent(t)],
        [t("收益分配", "Income use"), income(fund.incomeUse, t)],
        [t("注册地", "Domicile"), fund.domicile ?? absent(t)],
        [t("复制方式", "Replication"), [fund.replication, fund.methodology].filter(Boolean).join(" · ") || absent(t)],
        [t("汇率对冲", "Currency hedging"), hedge(fund.hedging, t)],
        [t("份额类别资产", "Share-class assets"), <SourceValue key="share-size" label={t("份额类别资产", "Share-class assets")} value={formatSize(profile?.shareClassSize) ?? absent(t)} evidence={facts?.share_class_size} t={t} />],
        [t("基金资产", "Fund assets"), <SourceValue key="fund-size" label={t("基金资产", "Fund assets")} value={formatSize(profile?.fundSize) ?? absent(t)} evidence={facts?.fund_size} t={t} />],
        [t("基金基础币种", "Fund base currency"), fund.baseCurrency ?? absent(t)],
        [t("份额币种", "Share-class currency"), fund.shareCurrency ?? absent(t)],
        [t("交易报价币种", "Listing quote currency"), matchingListing?.quoteCurrency ?? (data.context?.quote.currency || absent(t))],
        [t("份额成立日期", "Share-class launch date"), fund.inception ?? absent(t)],
      ]} />
      {Boolean(metrics.longBusinessSummary) && <details className="mx-details">
        <summary>{t("投资目标", "Investment objective")}</summary>
        <p>{str(metrics.longBusinessSummary)}</p>
      </details>}
    </Panel>
  );
}

function FundTracking({ fund }: { fund: Fund }) {
  const t = useCopy(), reading = fundReading(fund);
  const annual = fund.annualReturns ?? [];
  const errorLabel = t("发行商披露的跟踪误差", "Issuer-published tracking error");
  const error = fund.trackingError == null ? absent(t) : percent(fund.trackingError, false, 2);
  return (
    <Panel title={t("指数与跟踪", "Index & tracking")} action={sourceLink(fund.sourceUrl, t("发行商原文", "Issuer source"))}>
      <Facts rows={[
        [t("跟踪指数", "Tracked index"), fund.benchmark
          ? <Link className="mx-text-link" href={indexHref(fund.benchmark)}>{fund.indexName}</Link>
          : fund.indexName ?? absent(t)],
        ...(fund.profile?.rebalanceFrequency ? [[t("再平衡频率", "Rebalancing frequency"), fund.profile.rebalanceFrequency] as const] : []).map(([k, v]): [string, string] => [k, v]),
        [t("一年跟踪差", "1-year tracking difference"), <EvidenceReading key="tracking" {...trackingDisplay(reading, t)} />],
        [errorLabel, <SourceValue key="tracking-error" label={errorLabel} value={error} evidence={fund.profile?.evidence?.tracking_error} t={t} />],
      ]} />
      {fund.profile?.indexRules && <details className="mx-details"><summary>{t("指数规则", "Index rules")}</summary><p>{fund.profile.indexRules}</p></details>}
      {annual.length ? <EvidenceTable
        label={t("年度净值与指数总回报", "Annual NAV and benchmark total returns")}
        rows={[...annual].sort((a, b) => b.year - a.year)}
        columns={[
          { label: t("年度", "Year"), value: (row) => row.year },
          { label: `NAV · ${fund.returnCurrency ?? "—"}`, numeric: true,
            value: (row) => <EvidenceReading display={percent(row.navReturn, true, 2)} description={t("份额净值总回报", "Share-class NAV total return") + " " + percent(row.navReturn, true, 2) + " · " + annualBasis(fund, row.year)} /> },
          { label: t("指数", "Index"), numeric: true,
            value: (row) => <EvidenceReading display={percent(row.benchmarkReturn, true, 2)} description={t("基准总回报", "Benchmark total return") + " " + percent(row.benchmarkReturn, true, 2) + " · " + annualBasis(fund, row.year)} /> },
          { label: t("跟踪差 · pp", "Tracking difference · pp"), numeric: true,
            value: (row) => <EvidenceReading display={signedPoints(row.trackingDifference * 100)} description={t("跟踪差", "Tracking difference") + " " + signedPoints(row.trackingDifference * 100) + " pp · " + annualBasis(fund, row.year)} /> },
        ]}
      /> : <Empty title={t("暂无可比的年度总回报", "No comparable annual total returns")} />}
    </Panel>
  );
}

function annualBasis(fund: Fund, year: number) {
  return [fund.issuer, fund.sourceUrl, fund.returnBasis, fund.indexName, fund.returnCurrency, year + "-12-31"].filter(Boolean).join(" · ");
}

function underlying(holding: Holding) {
  return !/cash|derivative|collateral|future|forward|swap|option/i.test(holding.assetClass) && holding.weightPct > 0;
}

function FundHoldings({ fund, onExplore }: { fund: Fund; onExplore: (ticker: string) => void }) {
  const t = useCopy(), reading = fundReading(fund);
  const snapshot = fund.holdings;
  const all = [...(snapshot?.holdings ?? [])].filter(underlying).sort((a, b) => b.weightPct - a.weightPct);
  const top = all.slice(0, 10);
  const overlap = overlapDisplay(reading, t);
  const weight = (n: number) => percent(n / 100, false, 2);
  const totalWeight = (snapshot?.holdings ?? []).reduce((sum, item) => sum + item.weightPct, 0);
  const topWeight = top.reduce((sum, item) => sum + item.weightPct, 0);
  const topBasis = [fund.issuer, snapshot?.evidence?.holdings?.sourceUrl, t("发行商持仓权重", "Issuer portfolio weights"), snapshot?.asOf].filter(Boolean).join(" · ");
  const allocations = [
    { label: t("行业", "Sectors"), values: snapshot?.industryWeights, evidence: snapshot?.evidence?.industry_weights },
    { label: t("地域", "Countries"), values: snapshot?.countryWeights, evidence: snapshot?.evidence?.country_weights },
    { label: t("持仓交易币种", "Holding market currencies"), values: snapshot?.currencyWeights, evidence: snapshot?.evidence?.currency_weights },
  ];
  return (
    <>
      <Panel title={t("持仓与重叠", "Holdings & overlap")} action={sourceLink(fund.sourceUrl, t("发行商原文", "Issuer source"))}>
        <Facts rows={[
          [t("组合重叠", "Portfolio overlap"), <EvidenceReading key="overlap" {...overlap} />],
          [t("覆盖率 · 基金 / 其余组合", "Coverage · fund / rest"), <span key="coverage" title={overlap.description}>{overlap.fundCoverage} / {overlap.restCoverage}</span>],
          ...(all.length ? [
            [t("证券数 / 已披露权重", "Securities / disclosed weight"), <span key="total" title={topBasis}>{number(all.length, 0)} / {weight(totalWeight)}</span>],
            [t("前十大集中度", "Top-ten concentration"), <span key="concentration" title={topBasis}>{weight(topWeight)}</span>],
          ] as [string, React.ReactNode][] : []),
        ]} />
        {fund.holdingsState === "holdings-stale" && <Tag tone="warn">{t("持仓已过期", "Holdings stale")}</Tag>}
        {top.length ? <EvidenceTable label={t("前十大持仓", "Top ten holdings")} rows={top} columns={[
          { label: t("证券", "Security"), value: (row) => row.ticker && row.assetClass.toLowerCase().includes("equit")
            ? <button className="mx-text-link" onClick={() => onExplore(row.ticker)}>{row.name || row.ticker}</button>
            : row.name || row.ticker || row.isin },
          { label: t("权重", "Weight"), numeric: true, value: (row) => <span title={topBasis}>{weight(row.weightPct)}</span> },
          { label: t("行业", "Sector"), value: (row) => row.industry ?? absent(t) },
          { label: t("地域", "Country"), value: (row) => row.country ?? absent(t) },
        ]} /> : <Empty title={fund.holdingsState === "data-failed"
          ? t("持仓数据读取失败", "Holdings data failed")
          : t("暂无持仓披露", "No holdings disclosure")} />}
        {allocations.map(({ label, values, evidence }) => <details className="mx-details" key={label}>
          <summary>{label}</summary>
          {Object.keys(values ?? {}).length ? <Facts rows={Object.entries(values ?? {}).sort((a, b) => b[1] - a[1]).map(([key, n]) =>
            [key, <SourceValue key={key} label={label + " " + key} value={weight(n)} evidence={evidence} t={t} />],
          )} /> : <p>{absent(t)}</p>}
        </details>)}
        <details className="mx-details">
          <summary>{t("重叠明细", "Overlap breakdown")}</summary>
          {fund.matches?.length ? <EvidenceTable label={t("相同证券的直接及穿透权重", "Direct and look-through weights in shared securities")}
            rows={fund.matches}
            columns={[
              { label: t("证券", "Security"), value: (row) => row.name },
              { label: t("基金", "Fund"), numeric: true, value: (row) => <span title={overlap.description}>{percent(row.fundWeight, false, 2)}</span> },
              { label: t("直接持有", "Direct"), numeric: true, value: (row) => <span title={overlap.description}>{row.restDirectWeight > 0 ? percent(row.restDirectWeight, false, 2) : "—"}</span> },
              { label: t("经其他基金", "Via other funds"), value: (row) => Object.keys(row.restViaFund).length
                ? <ul className="mx-etf-contributors">{Object.entries(row.restViaFund).map(([isin, value]) => <li key={isin} title={overlap.description}>{isin} · {percent(value, false, 2)}</li>)}</ul> : "—" },
            ]}
          /> : <p>{reading.overlap.value === 0 ? t("没有已识别的共同证券", "No identified securities in common") : absent(t)}</p>}
        </details>
      </Panel>
    </>
  );
}

function FundPeers({ data, isin }: { data: ResearchLensSnapshot; isin?: string | null }) {
  const t = useCopy();
  const query = useQuery(etfPortfolioQuery(data.runId));
  const held = query.data?.runId === data.runId ? query.data.funds ?? [] : [];
  const current = findETF(held, data.ticker, isin) ?? (!isin
    ? findETF(held, data.ticker.replace(/\.L$/, "")) : undefined);
  // Both Nasdaq lines are worth comparing: only the held share classes can enter this table.
  const nasdaq = new Set(["IE0032077012", "IE00BYVTMW98"]);
  const peers = current ? held.filter((fund) => fund !== current && (
    (current.indexName && fund.indexName === current.indexName)
    || (nasdaq.has(current.isin ?? "") && nasdaq.has(fund.isin ?? ""))
  )) : [];
  const rows = current ? [current, ...peers.slice(0, 4)] : [];
  if (query.isPending) return <Pending />;
  if (query.isError) return <QueryError retry={query.refetch} />;
  return <Panel title={t("同类", "Peers")}>
    {rows.length ? <EvidenceTable label={t("已持有 ETF 对比", "Compare held ETFs")} rows={rows} columns={[
      { label: "ETF", value: (row) => <Link className="mx-text-link" href={`/research?ticker=${encodeURIComponent(row.tickers[0])}&view=peers`}>{row.tickers[0]}</Link> },
      { label: t("指数", "Index"), value: (row) => row.indexName ?? absent(t) },
      { label: t("注册地", "Domicile"), value: (row) => row.domicile ?? absent(t) },
      { label: t("对冲", "Hedging"), value: (row) => hedge(row.hedging, t) },
      { label: t("收益", "Income"), value: (row) => income(row.incomeUse, t) },
      { label: t("费用率", "Fee"), numeric: true, value: (row) => <SourceValue t={t} label={row.feeBasis ?? t("费用率", "Fee")} value={row.expenseRatio == null ? absent(t) : percent(row.expenseRatio, false, 2)} evidence={row.evidence?.expense_ratio} /> },
      { label: t("份额类别资产", "Share-class assets"), numeric: true, value: (row) => <SourceValue t={t} label={t("份额类别资产", "Share-class assets")} value={formatSize(row.shareClassSize) ?? absent(t)} evidence={row.evidence?.share_class_size} /> },
      { label: t("一年跟踪差", "1-year tracking difference"), numeric: true, value: (row) => <EvidenceReading {...trackingDisplay(row, t)} /> },
      { label: t("组合重叠", "Portfolio overlap"), numeric: true, value: (row) => <EvidenceReading {...overlapDisplay(row, t)} /> },
    ]} /> : <Empty title={t("暂无已持有的 ETF", "No held ETFs available")} />}
  </Panel>;
}

export function FundJournal({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const fund = useQuery(fundQuery(data.ticker, data.runId, "journal"));
  const prices = useQuery(researchPriceQuery(data.ticker, data.runId, "1d"));
  const marks = [...(prices.data?.tradeMarkers ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const disclosures = [...(fund.data?.disclosures ?? [])].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return <>
    <Panel title={t("交易记录", "Trade marks")}>
      {prices.isPending ? <Pending /> : prices.isError ? <QueryError retry={prices.refetch} /> : marks.length ? <EvidenceTable
        label={t("交易记录", "Trade marks")} rows={marks}
        columns={[
          { label: t("交易日", "Trade date"), value: (row) => <time title={t("券商交易流水", "Broker transaction ledger")}>{row.date}</time> },
          { label: t("标记", "Mark"), value: (row) => row.kind },
          { label: t("账户", "Accounts"), value: (row) => row.accounts.map((a) => a === "isa" ? "ISA" : "Invest").join(" / ") },
        ]}
      /> : <Empty title={t("暂无交易记录", "No trade marks")} />}
    </Panel>
    <Panel title={t("指数变动与持仓披露", "Index changes & holdings disclosures")}>
      {fund.isPending ? <Pending /> : fund.isError ? <QueryError retry={fund.refetch} /> : disclosures.length ? <EvidenceTable
        label={t("发行商披露", "Issuer disclosures")} rows={disclosures} columns={[
          { label: t("日期", "Date"), value: (row) => <time title={row.sourceUrl ?? undefined}>{row.effectiveAt ?? row.observedAt.slice(0, 10)}</time> },
          { label: t("事项", "Event"), value: (row) => row.kind === "holdings"
            ? sourceLink(row.sourceUrl, t("持仓披露", "Holdings disclosure")) ?? t("持仓披露", "Holdings disclosure")
            : `${row.previousValue ?? ""} → ${row.value}` },
        ]}
      /> : <Empty title={t("暂无已记录的发行商披露", "No recorded issuer disclosures")} />}
    </Panel>
  </>;
}
