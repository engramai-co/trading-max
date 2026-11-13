"use client";

import type { components } from "@/lib/api-schema";
import type { ResearchLensSnapshot } from "@/lib/types";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { currency, number, percent, safeUrl } from "@/workspace/data";
import { api, object, str } from "./data";
import {
  fieldEvidence, overlapDisplay, signedPoints, trackingDisplay,
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

export function fundQuery(ticker: string, runId: string, detail: "profile" | "full" | "journal" | "peers" = "full") {
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

export function FundWorkbench({ data, mode, onExplore }: {
  data: ResearchLensSnapshot; mode: FundMode; onExplore: (ticker: string) => void;
}) {
  if (mode === "peers") return <FundPeers data={data} />;
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

function UKReporting({ fund }: { fund: Fund }) {
  const t = useCopy();
  const status = fund.ukReportingFund;
  if (!status) return absent(t);
  const label = {
    reporting: t("已获批", "Approved"),
    ceased: t("已终止", "Ceased"),
    "effective-later": t("待生效", "Not yet effective"),
    "not-listed": t("未在名单中找到", "No register match"),
    unavailable: absent(t),
  }[status.state];
  const basis = status.ceasedOn && status.state === "ceased" ? status.ceasedOn : status.effectiveFrom;
  return <span className="mx-etf-evidence">
    <span>{label}{basis && <> · <time dateTime={basis}>{basis}</time></>}</span>
    <Help label={t("英国申报基金状态", "UK reporting fund status")}>
      <p>{t("HMRC 名单", "HMRC register")}{status.publicationDate && ` · ${status.publicationDate}`}</p>
      {status.effectiveFrom && <p>{t("生效日期", "Effective from")} · {status.effectiveFrom}</p>}
      {status.ceasedOn && <p>{t("终止日期", "Ceased on")} · {status.ceasedOn}</p>}
      {status.evidence?.fetchedAt && <p>{t("读取于", "Fetched")} {status.evidence.fetchedAt}</p>}
      <p>{sourceLink(status.evidence?.sourceUrl, t("HMRC 原始名单", "Original HMRC register"))}</p>
      <p>{t("含按英国开放政府许可 3.0 版使用的公共部门信息。", "Contains public sector information licensed under the Open Government Licence v3.0.")}</p>
    </Help>
  </span>;
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
            <Facts rows={[
              [feeName, fee],
              [t("买卖价差", "Bid–ask spread"), absent(t)],
              [t("溢折价", "Premium / discount"), absent(t)],
            ]} />
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
        [t("英国申报基金状态", "UK reporting fund status"), <UKReporting key="hmrc" fund={fund} />],
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
        [t("日度净值历史", "Daily NAV history"), absent(t)],
        [t("日度跟踪误差", "Daily tracking error"), absent(t)],
        [t("溢折价", "Premium / discount"), absent(t)],
        [t("买卖价差", "Bid–ask spread"), absent(t)],
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

function FundPeers({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const query = useQuery(fundQuery(data.ticker, data.runId, "peers"));
  if (query.isPending) return <Pending />;
  if (query.isError) return <QueryError retry={query.refetch} />;
  const comparison = query.data?.peerComparison;
  if (!comparison) return <Panel title={t("同类", "Peers")}>
    <Empty title={t("暂无已核实的同类份额", "No verified peers available")} />
  </Panel>;
  const fee = t("费率", "Fee");
  const size = t("份额类别资产", "Share-class assets");
  const tracking = t("一年跟踪差", "1-year tracking difference");
  const overlap = t("组合重叠", "Portfolio overlap");
  const metrics = { fee, shareClassSize: size, tracking, overlap };
  return <Panel title={t("同类", "Peers")} help={
    <>
      <p>{[comparison.benchmark, comparison.domicile, hedge(comparison.hedging, t), income(comparison.incomeUse, t)].join(" · ")}</p>
      <p>{t("分位按数值从低到高排列，并列取中间位置。每项只与有同口径读数的份额比较。", "Percentiles rank values from low to high, with ties at the midpoint. Each metric uses only share classes with comparable readings.")}</p>
      <p>{t("快照时间", "Snapshot time")} · {comparison.publishedAt}</p>
    </>
  }>
    <EvidenceTable label={t("同类 ETF 对比", "Compare peer ETFs")} rows={comparison.funds} columns={[
      { label: "ETF", value: (row) => row.heldTicker
        ? <Link className="mx-text-link" href={`/research?ticker=${encodeURIComponent(row.heldTicker)}&view=peers`} title={row.name}>{row.heldTicker}</Link>
        : sourceLink(row.sourceUrl, row.name) ?? row.name },
      { label: fee, numeric: true, value: (row) => row.fee
        ? <SourceValue t={t} label={row.fee.basis} value={percent(row.fee.value, false, 2)} evidence={row.fee.evidence} />
        : "—" },
      { label: size, numeric: true, value: (row) => row.shareClassSize
        ? <SourceValue t={t} label={size} value={currency(row.shareClassSize.value, row.shareClassSize.basis, 0)} evidence={row.shareClassSize.evidence} />
        : "—" },
      { label: tracking, numeric: true, value: (row) => row.tracking
        ? <EvidenceReading {...trackingDisplay({ tracking: row.tracking, indexName: comparison.benchmark }, t)} />
        : "—" },
      { label: overlap, numeric: true, value: (row) => row.overlap
        ? <EvidenceReading {...overlapDisplay({ overlap: row.overlap, evidence: row.overlapEvidence ? { holdings_date: row.overlapEvidence } : undefined }, t)} />
        : "—" },
    ]} />
    <details className="mx-details">
      <summary>{t("本基金分位", "This fund’s percentiles")}</summary>
      <Facts rows={Object.entries(metrics).map(([key, label]) => {
        const rank = comparison.ranks?.[key];
        const title = rank && [
          t("可比份额", "Comparable share classes") + ": " + rank.comparableIsins.join(", "),
          t("快照时间", "Snapshot time") + ": " + comparison.publishedAt,
        ].join(" · ");
        return [label, rank
          ? <span className="mx-etf-evidence" key={key} title={title}>
            {t("第 {value} 分位", "Percentile {value}").replace("{value}", number(rank.percentile, 2))}
            <small>· {rank.count}{t(" 只", " funds")}</small>
          </span>
          : "—"];
      })} />
    </details>
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
          { label: t("日期", "Date"), value: (row) => <time title={t("观察于", "Observed") + " " + row.observedAt}>{row.effectiveAt ?? row.observedAt.slice(0, 10)}</time> },
          { label: t("事项", "Event"), value: (row) => row.kind === "holdings"
            ? sourceLink(row.sourceUrl, t("持仓披露", "Holdings disclosure")) ?? t("持仓披露", "Holdings disclosure")
            : <span className="mx-etf-evidence">
              {`${row.previousValue ?? "—"} → ${row.value}`}
              <Help label={t("基准变更记录", "Observed benchmark change")}>
                <p>{t("观察于", "Observed")} {row.observedAt}</p>
                <p>{t("生效日期", "Effective date")} · {row.effectiveAt ?? absent(t)}</p>
                {row.evidence?.fetchedAt && <p>{t("读取于", "Fetched")} {row.evidence.fetchedAt}</p>}
                <p>{sourceLink(row.sourceUrl, t("当前发行商来源", "Current issuer source"))}</p>
                <p>{sourceLink(row.previousEvidence?.sourceUrl, t("先前发行商来源", "Previous issuer source"))}</p>
              </Help>
            </span> },
        ]}
      /> : <Empty title={t("暂无已记录的发行商披露", "No recorded issuer disclosures")} />}
    </Panel>
  </>;
}
