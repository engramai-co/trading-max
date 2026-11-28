"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { WorkspaceSheet } from "./overlay";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { ListFilter, Search } from "lucide-react";
import { useBreakpoint } from "@/lib/hooks";
import Link from "./link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useLocale } from "@/components/locale-provider";
import { useFinePointer } from "@/ui/pointer";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { LookthroughData, LookthroughPosition } from "@/lib/types";
import { EvidenceTable } from "./evidence-table";
import { AllocationComposition, type AllocationSlice } from "./allocation-composition";
import { companyAllocation } from "./company-allocation";
import { currency, number, objects, percent, safeUrl, str } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import {
  Empty,
  Facts,
  Freshness,
  UpdateFailure,
  Instrument,
  Metric,
  Panel,
  Pending,
  QueryError,
  QueryReadStatus,
  Segments,
  TabPanel,
  Tabs,
  TabsScope,
  Tag,
  useCopy,
} from "./foundation";
import { countryName, industryName } from "./exposure-names";
import {
  filterPreparedPositions,
  LOOKTHROUGH_BATCH_SIZE,
  lookthroughCountryKey,
  prepareLookthroughPositions,
  sortPreparedPositions,
  yieldToMain,
  type LookthroughOwnership,
  type LookthroughSort,
  type PreparedLookthroughRow,
} from "./look-through-data";
import { MarketQuoteBasis, SecurityPeek } from "./security-peek";
import { PageInspection } from "./assistant/inspection-entry";
import { useAssistant, useAssistantPageContext } from "./assistant/context";
import { useSearchParams } from "next/navigation";
import { Narrative } from "./narrative";
import { SearchPicker, SelectPicker } from "./picker";

/** Coverage below this is named; above it the page stays quiet. */
const COVERAGE_FLOOR = 0.98;
const PHONE_PAGE_SIZE = 25;
const DESKTOP_PAGE_SIZE = 100;

// The CSS probe uses the same queries as the record variants. Keep the
// screen's mounted layout when the print sheet crosses those breakpoints.
function useCompactRecords(probe: HTMLElement | null) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    if (!probe) return;
    const print = window.matchMedia("print");
    const sync = () => {
      if (!print.matches) setCompact(probe.getClientRects().length > 0);
    };
    const resize = new ResizeObserver(sync);
    resize.observe(probe);
    print.addEventListener("change", sync);
    sync();
    return () => {
      resize.disconnect();
      print.removeEventListener("change", sync);
    };
  }, [probe]);
  return compact;
}

const DesktopHoldingRow = memo(function DesktopHoldingRow({
  item,
  exposureLabel,
  onSelect,
}: {
  item: PreparedLookthroughRow;
  exposureLabel: string;
  onSelect: (position: LookthroughPosition) => void;
}) {
  const p = item.position;
  const peekPosition = useMemo(
    () => ({ valueGbp: p.valueGbp, weightPct: p.allocationPct, label: exposureLabel }),
    [p.valueGbp, p.allocationPct, exposureLabel],
  );
  return (
    <TableRow>
      <TableHead scope="row">
        <button
          className="mx-table-button"
          onClick={() => onSelect(p)}
        >
          <SecurityPeek
            ticker={p.ticker}
            range="1D"
            position={peekPosition}
          >
            <Instrument
              ticker={p.ticker ?? "—"}
              name={p.name}
              small
            />
          </SecurityPeek>
        </button>
      </TableHead>
      <TableCell>{item.countryLabel}</TableCell>
      <TableCell className="mx-align-right">{currency(p.directValueGbp)}</TableCell>
      <TableCell className="mx-align-right">{currency(p.indirectValueGbp)}</TableCell>
      <TableCell className="mx-align-right">
        <strong>{currency(p.valueGbp)}</strong>
        <small>{percent(p.allocationPct)}</small>
      </TableCell>
    </TableRow>
  );
});

const MobileHoldingCard = memo(function MobileHoldingCard({
  item,
  directLabel,
  fundsLabel,
  onSelect,
}: {
  item: PreparedLookthroughRow;
  directLabel: string;
  fundsLabel: string;
  onSelect: (position: LookthroughPosition) => void;
}) {
  const p = item.position;
  return (
    <button
      className="mx-holding-mobile"
      onClick={() => onSelect(p)}
    >
      <div>
        <Instrument
          ticker={p.ticker ?? "—"}
          name={p.name}
          small
        />
        <span className="mx-row-value">
          {currency(p.valueGbp)}
          <small>{percent(p.allocationPct)}</small>
        </span>
      </div>
      <footer>
        <span>{item.countryLabel}</span>
        <span>
          {directLabel} {currency(p.directValueGbp)} ·{" "}
          {fundsLabel} {currency(p.indirectValueGbp)}
        </span>
      </footer>
    </button>
  );
});

const UnderlyingHoldings = memo(function UnderlyingHoldings({
  items,
  expanded,
  batchKey,
  phone,
  sort,
  onSelect,
}: {
  items: PreparedLookthroughRow[];
  expanded: boolean;
  batchKey: string;
  phone: boolean;
  sort: LookthroughSort;
  onSelect: (position: LookthroughPosition) => void;
}) {
  const t = useCopy();
  const firstPageSize = phone ? PHONE_PAGE_SIZE : DESKTOP_PAGE_SIZE;
  const [batch, setBatch] = useState({ key: batchKey, limit: firstPageSize });
  // A filter, sort or toggle starts a new expansion. A snapshot keeps its mounted rows.
  const limit = batch.key === batchKey ? batch.limit : firstPageSize;
  if (batch.key !== batchKey) {
    setBatch({ key: batchKey, limit: firstPageSize });
  }
  const itemCount = items.length;
  const count = expanded ? Math.min(itemCount, limit) : itemCount;

  useEffect(() => {
    if (count === itemCount) return;
    let cancelled = false;
    void yieldToMain().then(() => {
      if (!cancelled) {
        const nextLimit = Math.min(count + LOOKTHROUGH_BATCH_SIZE, itemCount);
        setBatch((current) =>
          current.key === batchKey && current.limit < nextLimit
            ? { key: batchKey, limit: nextLimit }
            : current,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [batchKey, count, itemCount]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const completeForPrint = () => flushSync(() => setBatch((current) =>
      current.limit < itemCount ? { key: batchKey, limit: itemCount } : current,
    ));
    window.addEventListener("beforeprint", completeForPrint);
    return () => window.removeEventListener("beforeprint", completeForPrint);
  }, [expanded, batchKey, itemCount]);

  const directLabel = t("直接", "Direct");
  const fundsLabel = t("基金", "Funds");
  const exposureLabel = t("敞口", "Exposure");
  // Reuse row elements across batches, including the props for rows already mounted.
  const rowElements = useMemo(
    () => items.map((item) => phone ? (
      <MobileHoldingCard
        key={item.key}
        item={item}
        directLabel={directLabel}
        fundsLabel={fundsLabel}
        onSelect={onSelect}
      />
    ) : (
      <DesktopHoldingRow
        key={item.key}
        item={item}
        exposureLabel={exposureLabel}
        onSelect={onSelect}
      />
    )),
    [items, phone, directLabel, fundsLabel, exposureLabel, onSelect],
  );

  if (!items.length) {
    return <Empty title={t("没有匹配的底层持仓", "No matching underlying holdings")} />;
  }
  const visibleRows = rowElements.slice(0, count);
  if (phone) {
    return <div className="mx-mobile-holdings mx-exposure-active">{visibleRows}</div>;
  }
  return (
    <Table containerProps={{ className: "mx-table-wrap mx-desktop-holdings mx-exposure-active" }} label={t("底层持仓", "Underlying holdings")} className="mx-table">
      <TableHeader>
        <TableRow>
          <TableHead scope="col" aria-sort={sort === "name" ? "ascending" : undefined}>{t("名称", "Name")}</TableHead>
          <TableHead scope="col">{t("国家/地区", "Country")}</TableHead>
          <TableHead scope="col" className="mx-align-right" aria-sort={sort === "direct" ? "descending" : undefined}>{t("直接持有", "Direct")}</TableHead>
          <TableHead scope="col" className="mx-align-right" aria-sort={sort === "indirect" ? "descending" : undefined}>{t("基金内持有", "Via funds")}</TableHead>
          <TableHead scope="col" className="mx-align-right" aria-sort={sort === "total" ? "descending" : undefined}>{t("合计敞口", "Total exposure")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{visibleRows}</TableBody>
    </Table>
  );
});

/** Pages of underlying assets; a narrow row shows « ‹ 2 / 44 › » in place of page numbers. */
function ExposurePager({
  label,
  total,
  value,
  onChange,
}: {
  /** Phones show a pager above and below the list, so each names its place. */
  label: string;
  total: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return <Pagination label={label} total={total} value={value} onChange={onChange} responsive />;
}

/**
 * The company list's controls. Desktop keeps every filter inline. Phones keep search with 筛选 on one row and
 * sort with the view switch on the next; country, sector and ownership open under 筛选, which counts those set.
 */
function CompanyToolbar({
  phone,
  search,
  filters,
  sort,
  view,
  active,
  filtered,
  count,
  onClear,
}: {
  phone: boolean;
  search: ReactNode;
  filters: ReactNode;
  sort: ReactNode;
  view: ReactNode;
  /** How many of country, sector and ownership are set. */
  active: number;
  /** A search or a filter is set, so the result count and 清除筛选 apply. */
  filtered: boolean;
  count: string;
  onClear: () => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useId();
  // Desktop: filters on the left, the view switch on the right, one row.
  if (!phone)
    return (
      <div className="mx-toolbar" style={{ margin: "20px 0" }}>
        <div className="mx-exposure-filters flex flex-wrap items-center gap-mx-sm">
          {search}
          {filters}
          {sort}
          {filtered && (
            <>
              <Button variant="ghost" onClick={onClear}>
                {t("清除筛选", "Clear filters")}
              </Button>
              <span role="status">{count}</span>
            </>
          )}
        </div>
        {view}
      </div>
    );
  return (
    <div className="mx-exposure-toolbar">
      <div className="mx-exposure-row">
        {search}
        <Button
          ref={toggle}
          variant="outline"
          className="mx-exposure-filter-toggle self-stretch h-auto aria-expanded:bg-muted aria-expanded:text-link"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
        >
          <ListFilter size={16} aria-hidden="true" />
          {t("筛选", "Filters")}
          {active > 0 && (
            <>
              <span className="mx-exposure-filter-count" aria-hidden="true">{active}</span>
              <span className="sr-only">{locale === "zh" ? `（已选 ${active} 项）` : `(${active} active)`}</span>
            </>
          )}
        </Button>
      </div>
      <div id={panel} className="mx-exposure-filter-panel" hidden={!open}>
        {filters}
      </div>
      <div className="mx-exposure-row">
        {sort}
        {view}
      </div>
      {/* Mounted while empty, so the first count after a change is announced as well. */}
      <div className="mx-exposure-result" data-filtered={filtered || undefined}>
        <span role="status">{filtered ? count : null}</span>
        {filtered && (
          <Button
            variant="ghost"
            onClick={(event) => {
              // The button leaves with the filters; keyboard focus returns to 筛选 rather than the page.
              const focused = event.currentTarget === document.activeElement;
              onClear();
              if (focused) toggle.current?.focus();
            }}
          >
            {t("清除筛选", "Clear filters")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Lookthrough() {
  const t = useCopy();
  const params = useSearchParams();
  const cited = params?.get("evidence") && params.get("snapshotId") || undefined;
  const query = useDashboardLens("holdings-lookthrough", undefined, true, cited ? {detail:"summary"} : undefined, cited);
  const publicationFailure = usePublicationFailure(query.dataUpdatedAt);
  const exposure = query.data?.lookthrough;
  const failure = query.isRefetchError ? { updatedAt: query.dataUpdatedAt, retry: query.refetch } : publicationFailure;
  useAssistantPageContext({ page: "holdings", scope: "broker_total" }, !exposure || Boolean(cited && query.isError));
  return <>
    <QueryReadStatus key={cited ?? "live"} label={t("穿透持仓", "Look-through holdings")}
      failed={!cited && query.isError && !query.data}
      refreshFailed={!!exposure?.available && !!failure?.updatedAt && (!cited || !query.isError)}
      ready={query.isSuccess && !!exposure} error={query.error} />
    {query.isPending ? (
    <Pending shape="holdings" label={t("正在读取穿透持仓…", "Loading look-through holdings…")} />
  ) : cited && query.isError ? (
    <div data-cited-missing=""><Empty title={t("引用的数据版本暂不可用","Cited publication unavailable")} /></div>
  ) : query.isError && !query.data ? (
    <QueryError retry={query.refetch} />
  ) : query.data && exposure ? (
    <Exposure key={cited ? params?.toString() : "latest"} data={exposure} snapshot={query.data.runId} failure={failure} />
  ) : (
    <Empty title={t("暂无穿透记录", "No look-through records")} />
  )}</>;
}
function Exposure({
  data,
  snapshot,
  failure,
}: {
  data: LookthroughData;
  snapshot: string;
  failure?: { updatedAt: number; retry: () => unknown };
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const finePointer = useFinePointer();
  const {ready, open: sidebarOpen} = useAssistant();
  const compactDesktop = useBreakpoint("compactDesktop");
  const dockedAssistant = sidebarOpen && !compactDesktop;
  const params = useSearchParams();
  const recordOnly = params?.get("record") === "1";
  const dimensionsByKey = {company: "companies", country:"countries", sector:"sectors", gics:"gics"} as const;
  const linkedDimension = params?.get("dimension") as keyof typeof dimensionsByKey;
  const linkedCompany = useMemo(() => {
    if (linkedDimension !== "company" || !params?.get("category") || params.get("group")) return null;
    const entity = params.get("entityId"), category = params.get("category");
    const matches = data.positions.filter(p => entity ? p.entityId === entity : (p.isin || p.ticker || p.name) === category);
    return matches.length === 1 ? matches[0] : null;
  }, [data.positions,linkedDimension,params]);
  const [choice, setChoice] = useState<{category: string; name:string; entityId?:string; group?: AllocationSlice["group"]; snapshotId?: string} | null>(() => {
    const category=params?.get("category");
    const group=params?.get("group");
    if (!category || !dimensionsByKey[linkedDimension]) return null;
    // A cited category arrives as its source name; the card titles it as the page lists it.
    const name = linkedCompany?.name ?? (linkedDimension === "country" ? countryName(category, locale)
      : linkedDimension === "company" ? category : industryName(category, locale));
    return {category,name,entityId:params?.get("entityId") ?? undefined, snapshotId: linkedCompany ? snapshot : undefined,
      ...(group==="tail" || group==="unresolved" ? {group} : {})};
  });
  const [initialChoice] = useState(choice);
  const [view, setView] = useState<
    "companies" | "countries" | "sectors" | "gics" | "sources"
  >(dimensionsByKey[linkedDimension] ?? "companies");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [country, setCountry] = useState("all");
  const [selection, setSelection] = useState(() => linkedCompany ? { position: linkedCompany, snapshotId: snapshot } : null);
  const selected = selection?.position;
  useAssistantPageContext({
    page: "holdings", scope: "broker_total", ticker: selected?.ticker ?? undefined, snapshotId: selection?.snapshotId ?? snapshot,
  });
  // The first row shown, so a page-size change keeps the same rows in view.
  const [start, setStart] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const phone = useBreakpoint("phone");
  const [recordProbe, setRecordProbe] = useState<HTMLSpanElement | null>(null);
  const compactRecords = useCompactRecords(recordProbe);
  const listTop = useRef<HTMLDivElement>(null);
  const [sector, setSector] = useState("all");
  const [ownership, setOwnership] = useState<LookthroughOwnership>("all");
  const [sort, setSort] = useState<LookthroughSort>("total");
  const [chart, setChart] = useState(params?.get("group") ? "pie" : "rank");
  const companyComposition = useMemo(() => companyAllocation(data), [data]);
  const prepared = useMemo(
    () => prepareLookthroughPositions(data.positions, locale),
    [data.positions, locale],
  );
  const sorted = useMemo(
    () => sortPreparedPositions(prepared.items, sort),
    [prepared.items, sort],
  );
  const rows = useMemo(
    () => filterPreparedPositions(sorted, { search: deferredSearch, country, sector, ownership }),
    [sorted, deferredSearch, country, sector, ownership],
  );

  const filtered = Boolean(search.trim()) || country !== "all" || sector !== "all" || ownership !== "all";
  const activeFilters = [country, sector, ownership].filter((value) => value !== "all").length;
  // Large pages keep the ranking scannable; "show all" lifts paging with the same filters.
  // Compact layouts page through 25 cards, with controls above and below.
  const pageSize = compactRecords ? PHONE_PAGE_SIZE : DESKTOP_PAGE_SIZE;
  const pages = showAll ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.floor(start / pageSize) + 1, pages);
  const setPage = (value: number) => setStart((value - 1) * pageSize);
  const batchKey = showAll
    ? JSON.stringify([deferredSearch, country, sector, ownership, sort])
    : "";
  const displayedRows = useMemo(
    () =>
      showAll
        ? rows
        : rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [showAll, rows, currentPage, pageSize],
  );

  const countryOptions = useMemo(
    () => [{ value: "all", label: t("全部国家", "All countries") }, ...prepared.countries],
    [prepared.countries, t],
  );
  const sectorOptions = useMemo(
    () => [{ value: "all", label: t("全部板块", "All sectors") }, ...prepared.sectors],
    [prepared.sectors, t],
  );

  const clearFilters = () => {
    setSearch("");
    setCountry("all");
    setSector("all");
    setOwnership("all");
    setPage(1);
  };
  const countryAllocation = useMemo(
    () =>
      [
        ...objects(data.countryAllocation)
          .reduce((merged, row) => {
            const key = lookthroughCountryKey(str(row.country));
            const previous = merged.get(key);
            merged.set(
              key,
              previous
                ? {
                    ...previous,
                    valueGbp: (numeric(previous.valueGbp) ?? 0) + (numeric(row.valueGbp) ?? 0),
                    allocationPct:
                      (numeric(previous.allocationPct) ?? 0) + (numeric(row.allocationPct) ?? 0),
                  }
                : row,
            );
            return merged;
          }, new Map<string, Record<string, unknown>>())
          .values(),
      ].sort((a, b) => (numeric(b.valueGbp) ?? 0) - (numeric(a.valueGbp) ?? 0)),
    [data.countryAllocation],
  );
  const allocations = useMemo(
    () =>
      view === "countries"
        ? countryAllocation
        : objects(
            view === "gics"
              ? data.gicsSubIndustryAllocation
              : data.industryAllocation,
          ),
    [view, countryAllocation, data.gicsSubIndustryAllocation, data.industryAllocation],
  );
  const inspect = useCallback(
    (row: Pick<AllocationSlice, "name" | "category" | "group" | "entityId">, snapshotId?: string) =>
      setChoice(
        row.category
          ? { name: row.name, category: row.category, entityId: row.entityId, group: row.group, snapshotId }
          : null,
      ),
    [],
  );
  const inspectPosition = useCallback(
    (position: LookthroughPosition, snapshotId: string) => inspect({
      name: position.name,
      entityId: position.entityId || undefined,
      category: position.isin || position.ticker || position.name,
    }, snapshotId),
    [inspect],
  );
  const selectPosition = useCallback(
    (position: LookthroughPosition) => {
      setSelection({ position, snapshotId: snapshot });
      if (ready) inspectPosition(position, snapshot);
    },
    [ready, inspectPosition, snapshot],
  );
  if (!data.available)
    return (
      <Panel>
        <Empty
          title={t(
            "底层持仓还在等待数据",
            "Underlying holdings are not available yet",
          )}
          description={t(
            "完成完整更新后，ETF 成分和分类覆盖将显示在这里。",
            "Run a full update to see ETF constituents and classification coverage.",
          )}
          action={
            <Link href="/health" data-slot="button" className={buttonVariants()}>
              {t("查看数据更新", "Open data status")}
            </Link>
          }
        />
      </Panel>
    );
  // "Taiwan" and "Taiwan Region" are one place; filters and totals use the country code.
  const place = lookthroughCountryKey;
  const countryLabel = (name: string | null | undefined) => countryName(name, locale);
  const className = (name: string | null | undefined) => industryName(name, locale);
  const allocationLabel = (r: Record<string, unknown>) =>
    r.country != null
      ? countryLabel(str(r.country))
      : className(str(r.subIndustry ?? r.name ?? r.industry ?? r.label)) || "—";
  const dimension = view === "companies" ? "company" : view === "sectors" ? "sector" : view === "countries" ? "country" : "gics";
  const categoryKey = (row: Record<string,unknown>) => str(row.country ?? row.subIndustry ?? row.industry ?? row.name);
  const citedWeight = params?.get("evidence") === "exposure_benchmark" && choice?.category === params.get("category") && dimension === linkedDimension;
  const source = params?.get("benchmarkSource"), asOf = params?.get("benchmarkAsOf"), observation = params?.get("benchmarkObservation");
  if (citedWeight && (source !== (dimension === "sector" ? "SWDA" : "SSAC") || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !observation || !/^bw_[0-9a-f]{16}$/.test(observation))) {
    return <div data-cited-missing=""><Empty title={t("引用的基准权重记录暂不可用","Cited benchmark weight unavailable")} /></div>;
  }
  const showBenchmarkRecord = Boolean(recordOnly && choice === initialChoice && citedWeight);
  const readingChoice = recordOnly && choice === initialChoice && !showBenchmarkRecord ? null : choice;
  const role = <PageInspection role="exposure" showInline={showBenchmarkRecord} object={choice?.name ?? t("穿透配置","Look-through allocation")}
    context={readingChoice ? {dimension,category:readingChoice.category,...(citedWeight && source && asOf && observation ? {citedBenchmark:source,citedBenchmarkAsOf:asOf,citedBenchmarkObservation:observation} : {}),...(readingChoice.entityId ? {entityId:readingChoice.entityId} : {}),...(readingChoice.group ? {group:readingChoice.group} : {})} : undefined} snapshotId={choice?.snapshotId ?? snapshot} onClose={() => setChoice(null)} />;
  if (params?.get("snapshotId") && choice && !choice.group) {
    const hasRecord = dimension === "company" ? !!linkedCompany || !params.get("category") || choice.category !== params.get("category")
      : allocations.some(row => dimension === "country" ? place(categoryKey(row)) === place(choice.category) : categoryKey(row) === choice.category);
    if (!hasRecord) return <div data-cited-missing=""><Empty title={t("引用的配置记录暂不可用","Cited allocation unavailable")} /></div>;
  }
  const changeChart = (value: string) => {setChoice(null); setChart(value);};
  const top = companyComposition.rows.slice(0, 3);
  const concentration = top.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  // The backend measures resolved securities against total invested value.
  const unresolved = data.investedValueGbp > 0 ? Math.max(0, 1 - data.lookthroughCoveragePct) : null;
  const classificationLow = data.gicsCoveragePct < COVERAGE_FLOOR;
  const dimensions = [
    { value: "companies" as const, label: t("公司", "Companies") },
    { value: "countries" as const, label: t("国家/地区", "Countries") },
    { value: "sectors" as const, label: t("板块", "Sectors") },
    { value: "gics" as const, label: t("GICS 子行业", "GICS sub-industries") },
    { value: "sources" as const, label: t("来源与覆盖", "Sources & coverage") },
  ];
  return (
    <>
      <div className="mx-exposure-basis">
        <span title={top.map(({ name }) => name).join(" · ")}>{t("前三大公司", "Top three companies")} <strong>{percent(concentration)}</strong></span>
        <span>{t("未穿透与其他资产", "Unresolved & other assets")} <strong>{percent(unresolved)}</strong></span>
        <span className="mx-exposure-denominator">{t("占全部投资账户已投资资产", "of invested assets across all investment accounts")}</span>
        {classificationLow && (
          <Tag tone="warn">
            {t("GICS 分类覆盖 ", "GICS classified ")}
            {percent(data.gicsCoveragePct)}
          </Tag>
        )}
        <Freshness date={data.brokerAsOf || data.generatedAt} />
        {failure && <UpdateFailure {...failure} />}
      </div>
      <Panel className="tm-table-variants">
        <span className="tm-table-mode-probe" ref={setRecordProbe} aria-hidden="true" />
        <TabsScope value={view} onChange={(value) => {setChoice(null); setView(value);}}>
        <Tabs activation="automatic"
          label={t("穿透维度", "Exposure dimension")}
          value={view}
          options={dimensions}
        />
        <TabPanel value={view}>
        {/* The open dimension heads its section, so the details below sit one level under it. */}
        <h2 className="sr-only">{dimensions.find((d) => d.value === view)?.label}</h2>
        {view === "companies" ? (
          <>
            <CompanyToolbar
              phone={phone}
              search={
                <SearchInput
                  className="mx-search-input"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.currentTarget.value);
                    setPage(1);
                  }}
                  aria-label={t("搜索底层持仓", "Search underlying holdings")}
                  placeholder={t(
                    "公司、代码、ISIN 或行业…",
                    "Company, ticker, ISIN or industry…",
                  )}
                  leading={<Search aria-hidden="true" size={18} />}
                />
              }
              filters={
                <>
                  <SearchPicker
                    aria-label={t("国家筛选", "Filter country")}
                    value={country}
                    onChange={(v) => {
                      setCountry(v ?? "all");
                      setPage(1);
                    }}
                    options={countryOptions}
                  />
                  <SearchPicker
                    aria-label={t("板块筛选", "Filter sector")}
                    value={sector}
                    onChange={(v) => {
                      setSector(v ?? "all");
                      setPage(1);
                    }}
                    options={sectorOptions}
                  />
                  <SelectPicker
                    aria-label={t("持有方式", "Ownership")}
                    value={ownership}
                    onChange={(v) => {
                      setOwnership((v as LookthroughOwnership | null) ?? "all");
                      setPage(1);
                    }}
                    options={[
                      { value: "all", label: t("全部持有方式", "All ownership") },
                      { value: "direct", label: t("仅直接持有", "Direct only") },
                      {
                        value: "indirect",
                        label: t("仅基金内持有", "Funds only"),
                      },
                      {
                        value: "both",
                        label: t("直接与基金内都有", "Direct and funds"),
                      },
                    ]}
                  />
                </>
              }
              sort={
                <SelectPicker
                  aria-label={t("敞口排序", "Sort exposure")}
                  value={sort}
                  onChange={(v) => {
                    setSort((v as LookthroughSort | null) ?? "total");
                    setPage(1);
                  }}
                  options={[
                    { value: "total", label: t("总敞口优先", "Largest total") },
                    {
                      value: "direct",
                      label: t("直接持有优先", "Largest direct"),
                    },
                    {
                      value: "indirect",
                      label: t("基金内持有优先", "Largest indirect"),
                    },
                    { value: "name", label: t("名称 A–Z", "Name A–Z") },
                  ]}
                />
              }
              view={
                <Segments
                  label={t("公司视图", "Company view")}
                  value={chart}
                  onChange={changeChart}
                  options={[
                    { value: "rank", label: t("排名", "Rank") },
                    // Phones show "Mix", so sort and the view switch share one row down to 320px.
                    { value: "pie", label: t("组成", "Composition"), short: t("组成", "Mix") },
                  ]}
                />
              }
              active={activeFilters}
              filtered={filtered}
              count={number(rows.length, 0) + " / " + number(data.positions.length, 0)}
              onClear={clearFilters}
            />
            {chart === "pie" && <AllocationComposition
              key={ready ? "companies" : `companies-${snapshot}`}
              companies
              initialGroup={choice?.group} onInspect={ready ? inspect : undefined} reading={role}
              rows={companyComposition.rows}
              remainder={companyComposition.remainder}
            />}
            {compactRecords && pages > 1 && (
              <div className="mx-exposure-paging mx-exposure-paging-top" ref={listTop}>
                <ExposurePager
                  label={t("底层持仓分页（列表上方）", "Underlying holding pages, above the list")}
                  total={pages}
                  value={currentPage}
                  onChange={setPage}
                />
              </div>
            )}
            <UnderlyingHoldings
              key={compactRecords ? "cards" : "table"}
              items={displayedRows}
              expanded={showAll}
              batchKey={batchKey}
              phone={compactRecords}
              sort={sort}
              onSelect={selectPosition}
            />
            {(pages > 1 || showAll) && (
              <div className="mx-exposure-paging">
                {pages > 1 && (
                  <ExposurePager
                    label={
                      compactRecords
                        ? t("底层持仓分页（列表下方）", "Underlying holding pages, below the list")
                        : t("底层持仓分页", "Underlying holding pages")
                    }
                    total={pages}
                    value={currentPage}
                    onChange={(value) => {
                      setPage(value);
                      // Return to the top of the compact list after changing pages.
                      if (compactRecords) listTop.current?.scrollIntoView({ block: "start" });
                    }}
                  />
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowAll((expanded) => !expanded);
                    setStart(0);
                  }}
                >
                  {showAll
                    ? t("分页显示", "Show in pages")
                    : t("显示全部 ", "Show all ") + number(rows.length, 0)}
                </Button>
              </div>
            )}
          </>
        ) : view === "sources" ? (
          <div className="mt-mx-lg flex flex-col gap-mx-lg">
            <Facts
              rows={[
                [
                  t("ETF 穿透覆盖", "ETF look-through coverage"),
                  percent(data.lookthroughCoveragePct),
                ],
                [
                  t("GICS 分类覆盖", "GICS classification coverage"),
                  percent(data.gicsCoveragePct),
                ],
                [t("ETF 投资市值", "ETF invested value"), currency(data.etfValueGbp)],
                [
                  t("已穿透市值", "Resolved value"),
                  currency(data.lookthroughValueGbp),
                ],
                [
                  t("已分类资产", "Classified assets"),
                  currency(data.gicsClassifiedValueGbp),
                ],
                [
                  t("待分类资产", "Awaiting classification"),
                  currency(data.gicsPendingValueGbp),
                ],
                [
                  t("不适用 GICS", "GICS not applicable"),
                  currency(data.gicsNotApplicableValueGbp),
                ],
                [t("现金", "Cash"), currency(data.cashValueGbp)],
              ]}
            />
            {objects(data.sources).map((source, i) => (
              <div className="mx-disclosure" key={i}>
                <strong>
                  {str(source.ticker ?? source.etfTicker ?? source.source) ||
                    t("数据来源", "Data source")}
                </strong>
                <Facts
                  rows={[
                    [
                      t("截至", "As of"),
                      str(source.asOf ?? source.holdingsAsOf) || "—",
                    ],
                    [
                      t("状态", "Status"),
                      (numeric(source.unweightedHoldingsCount) ?? 0) > 0
                        ? t("部分记录未提供权重", "Some holdings have no reported weight")
                        : source.status === "verified"
                          ? t("已核验", "Verified")
                          : t("暂不可用", "Unavailable"),
                    ],
                    [t("发行商", "Issuer"), str(source.issuer) || "—"],
                    [
                      t("成分记录数", "Constituent records"),
                      number(source.holdingsCount, 0),
                    ],
                    [
                      t("已覆盖权重", "Resolved weight"),
                      number(source.weightTotalPct) + "%",
                    ],
                  ]}
                />
                {safeUrl(str(source.sourceUrl)) && (
                  <a
                    className="mx-text-link"
                    href={safeUrl(str(source.sourceUrl))}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("查看来源", "View source")}
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 18 }}>
            <div className="mb-mx-md flex flex-wrap items-center justify-between gap-mx-md">
              <Segments
                label={t("配置图形", "Allocation chart")}
                value={chart}
                onChange={changeChart}
                options={[
                  { value: "rank", label: t("明细", "Details") },
                  { value: "pie", label: t("组成", "Composition"), short: t("组成", "Mix") },
                ]}
              />
            </div>
            {chart === "pie" && <AllocationComposition
              initialGroup={choice?.group} onInspect={ready ? inspect : undefined} reading={role}
              key={ready ? view : `${view}-${snapshot}`}
              rows={allocations.map((row) => ({
                name: allocationLabel(row),category: categoryKey(row),
                value: numeric(row.valueGbp),
                weight: numeric(row.allocationPct),
              }))}
            />}
            {chart !== "pie" && role}
            <EvidenceTable
              key={view}
              label={t("完整配置明细", "Complete allocation details")}
              rows={allocations}
              rowKey={categoryKey}
              className="tm-allocation-table"
              columns={[
                { label: t("分类", "Category"), value: row => ready ? <button type="button" className="mx-text-link" data-cited-allocation={params?.has("evidence") && (dimension === "country" ? place(categoryKey(row)) === place(params.get("category") ?? "") : categoryKey(row) === params.get("category")) || undefined} onClick={() => inspect({name:allocationLabel(row),category:categoryKey(row)})}>{allocationLabel(row)}</button> : allocationLabel(row) },
                {
                  label: t("金额 · GBP", "Value · GBP"),
                  value: (r) => currency(r.valueGbp),
                  numeric: true,
                },
                {
                  label: t("权重", "Weight"),
                  value: (r) => percent(r.allocationPct),
                  numeric: true,
                },
              ]}
            />
          </div>
        )}
        </TabPanel>
        </TabsScope>
      </Panel>
      <Narrative snapshot={snapshot} lens="hidden_exposure" page="holdings" />
      {view === "companies" && chart !== "pie" && (!selected || phone) && role}
      <WorkspaceSheet
        modal={!dockedAssistant}
        preventOutsideDismiss={dockedAssistant}
        className={dockedAssistant ? "mx-exposure-sheet-docked" : undefined}
        open={Boolean(selection) && !(phone && (sidebarOpen || (ready && readingChoice)))}
        onClose={() => {setSelection(null); setChoice(null);}}
        title={t("穿透后的真实敞口", "Underlying exposure")}
        closeLabel={t("关闭底层敞口", "Close underlying exposure")}
      >
        {selection && selected && (
          <div className="mx-cited-holding-details flex flex-col gap-mx-lg">
            <Instrument ticker={selected.ticker ?? "—"} name={selected.name} />
            <Metric
              large
              label={t("合计敞口", "Total exposure")}
              value={currency(selected.valueGbp, "GBP", 2)}
            />
            <Facts
              rows={[
                [
                  t("直接持有", "Direct"),
                  currency(selected.directValueGbp),
                ],
                [
                  t("基金内持有", "Via funds"),
                  currency(selected.indirectValueGbp),
                ],
                [
                  t("组合占比", "Portfolio weight"),
                  percent(selected.allocationPct),
                ],
                [t("国家/地区", "Country"), countryName(selected.country, locale)],
                [
                  t("子行业", "Sub-industry"),
                  selected.gics?.subIndustryName
                    ? industryName(selected.gics.subIndustryName, locale)
                    : t("未分类", "Unclassified"),
                ],
                ["ISIN", selected.isin ?? "—"],
              ]}
            />
            {!finePointer && <MarketQuoteBasis ticker={selected.ticker} />}
            {chart !== "pie" && (phone && ready ?
              <button type="button" data-autofocus className="mx-text-link"
                onClick={() => inspectPosition(selected, selection.snapshotId)}>
                ✦ {t("敞口","Exposure")}
              </button> : role)}
            <Panel title={t("通过这些基金持有", "Held through these funds")}>
              {objects(selected.etfContributors).length ? (
                objects(selected.etfContributors).map((c, i) => (
                  <Facts
                    key={i}
                    rows={[
                      [
                        str(c.etfTicker ?? c.ticker ?? c.name) || "—",
                        currency(c.valueGbp ?? c.contributionGbp),
                      ],
                    ]}
                  />
                ))
              ) : (
                <p className="mx-prose">
                  {t("无间接持仓来源。", "No indirect holding sources.")}
                </p>
              )}
            </Panel>
            {selected.ticker && (
              <Link
                href={"/research?ticker=" + encodeURIComponent(selected.ticker)}
                data-slot="button"
                className={buttonVariants()}
              >
                {t("查看研究", "View research")}
              </Link>
            )}
          </div>
        )}
      </WorkspaceSheet>
    </>
  );
}
