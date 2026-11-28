"use client";

import { hashKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import type { Locale } from "@/components/locale-provider";
import { dashboardLensLatestKey } from "@/lib/dashboard-query";
import { useMediaQuery } from "@/lib/hooks";
import {
  isActiveOverviewWorkspace,
  OVERVIEW_LAYOUT_GENERATION_SUFFIX,
  OVERVIEW_LAYOUT_MEDIA,
  OVERVIEW_LAYOUT_VERSION_PREFIX,
  parseOverviewLayout,
  prepareOverviewLayoutStorage,
  type LedgerRows,
  type OverviewLayout,
  type ReadingLayout,
} from "@/lib/overview-layout-storage";
import type { Range, Scope } from "@/lib/portfolio/nav";
import type { DashboardLens } from "@/lib/types";
import { useSnapshotCacheScope } from "@/ui/snapshot-cache-provider";

const subscribe = () => () => {};
const serverSnapshot = () => undefined;
const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const overviewSummary = hashKey(dashboardLensLatestKey("overview", undefined, { detail: "summary" }));

export function hasOverviewAccountData(data: DashboardLens) {
  return data.totalValueGbp != null || (data.accounts ?? []).some(account => account.isInvestable);
}

/** The browser remembers only row counts, geometry and range. The ledger still flows with the page. */
export function useOverviewLayout(account: Scope, locale: Locale, confirmedEmpty: boolean) {
  const workspace = useSnapshotCacheScope();
  const client = useQueryClient();
  const phone = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.phone);
  const narrow = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.narrow);
  const singleColumn = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.tablet);
  const compact = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.compact);
  const breakpoint = phone ? narrow ? "narrow-phone" : "phone" : singleColumn ? "tablet" : compact ? "compact" : "desktop";
  const workspacePrefix = workspace ? OVERVIEW_LAYOUT_VERSION_PREFIX + workspace + ":" : undefined;
  // Each workspace can write at most 3 accounts × 2 locales × 5 breakpoints.
  const key = workspacePrefix ? workspacePrefix + [account, locale, breakpoint].join(":") : undefined;
  const generationKey = key && key + OVERVIEW_LAYOUT_GENERATION_SUFFIX;
  const [read, setRead] = useState<{ workspace: string; generations?: Map<string, string | null> }>();
  useLayoutEffect(() => {
    if (!workspacePrefix) return;
    // Only an actual successful response renews the write permission. Layout changes and restored snapshots do not.
    return client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual ||
          event.query.queryHash !== overviewSummary) return;
      const data = event.query.state.data as DashboardLens;
      try {
        if (!isActiveOverviewWorkspace(workspacePrefix)) return;
        const generations = hasOverviewAccountData(data) ? new Map(Object.keys(localStorage)
          .filter(name => name.startsWith(workspacePrefix) && name.endsWith(OVERVIEW_LAYOUT_GENERATION_SUFFIX))
          .map(name => [name, localStorage.getItem(name)] as const)) : undefined;
        setRead({ workspace: workspacePrefix, generations });
      } catch {}
    });
  }, [client, workspacePrefix]);
  const getSnapshot = useCallback(() => {
    if (!key || !generationKey || !workspacePrefix || confirmedEmpty) return null;
    try {
      if (isActiveOverviewWorkspace(workspacePrefix)) {
        return localStorage.getItem(key) ?? (localStorage.getItem(generationKey) === null ? sessionStorage.getItem(key) : null);
      }
    } catch {}
    return null;
  }, [workspacePrefix, key, generationKey, confirmedEmpty]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const layout = useMemo(() => parseOverviewLayout(raw), [raw]);
  useLayoutEffect(() => {
    if (!workspacePrefix || !key || !generationKey) return;
    try {
      if (confirmedEmpty) {
        if (read?.workspace !== workspacePrefix || read.generations || !isActiveOverviewWorkspace(workspacePrefix)) return;
        localStorage.setItem(generationKey, crypto.randomUUID());
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } else {
        prepareOverviewLayoutStorage(workspacePrefix, key);
      }
    } catch {
      // The page also works with storage disabled.
    }
  }, [workspacePrefix, key, generationKey, confirmedEmpty, read]);
  const generation = generationKey && read?.workspace === workspacePrefix && read?.generations
    ? read.generations.get(generationKey) ?? null : undefined;
  return { key, workspacePrefix, generation, layout, booting: raw === undefined };
}

export function useSaveOverviewLayout(
  host: RefObject<HTMLDivElement | null>,
  key: string | undefined,
  workspace: string | undefined,
  generation: string | null | undefined,
  chart: { selection: { range: Range }; history?: object } | undefined,
  ready: boolean,
  rows: LedgerRows | undefined,
) {
  const stocks = rows?.stocks;
  const funds = rows?.funds;
  const dateTagged = rows?.dateTagged;
  useLayoutEffect(() => {
    const root = host.current;
    if (!ready || !root || !key || !workspace || generation === undefined || stocks === undefined || funds === undefined) return;
    const summary = root.querySelector<HTMLElement>(".mx-overview-portfolio");
    const history = root.querySelector<HTMLElement>(".mx-overview-history");
    const plot = history?.querySelector<HTMLElement>(".mx-plot");
    const periodFigure = history?.querySelector<HTMLElement>(".mx-data-body .mx-period-figure");
    const ledger = root.querySelector<HTMLElement>(".mx-overview-holdings > :is(.mx-ledger, .mx-empty)");
    if (!ledger) return;
    const save = () => {
      const ledgerHeight = ledger.getBoundingClientRect().height;
      let reading: ReadingLayout | undefined;
      if (chart?.history && summary && history) {
        const summaryHeight = summary.getBoundingClientRect().height;
        const panel = history.getBoundingClientRect();
        const plotTop = plot ? plot.getBoundingClientRect().top - panel.top - history.clientTop : undefined;
        if (summaryHeight && panel.height) reading = {
          range: chart.selection.range, summary: summaryHeight, history: panel.height,
          plotTop: dimension(plotTop) ? plotTop : undefined,
          periodFigure: periodFigure?.getBoundingClientRect().height,
        };
      }
      try {
        const current = localStorage.getItem(key);
        const prior = parseOverviewLayout(current);
        const sectors = root.querySelector<HTMLElement>(".mx-overview-sectors");
        const brief = root.querySelector<HTMLElement>(".mx-overview-brief");
        const digest = brief?.querySelector<HTMLElement>(".mx-digest");
        const digestHeight = digest?.getBoundingClientRect().height;
        const layout: OverviewLayout = {
          rows: { stocks, funds, dateTagged }, ledger: ledgerHeight, reading,
          sectors: sectors?.classList.contains("mx-overview-sectors-pending") ? prior?.sectors : sectors?.getBoundingClientRect().height,
          brief: brief && (!digest || digest.hasAttribute("data-waiting")) ? prior?.brief ?? digestHeight : digestHeight,
        };
        const validated = parseOverviewLayout(JSON.stringify(layout));
        if (!isActiveOverviewWorkspace(workspace) || localStorage.getItem(key + OVERVIEW_LAYOUT_GENERATION_SUFFIX) !== generation) return;
        if (!validated) {
          localStorage.removeItem(key);
          return;
        }
        const value = JSON.stringify(validated);
        if (current !== value) localStorage.setItem(key, value);
      } catch {
        // The live page and its count-based skeleton also work with storage disabled.
      }
    };
    const observer = new ResizeObserver(save);
    [root, summary, history, plot, ledger].forEach((element) => { if (element) observer.observe(element); });
    save();
    return () => observer.disconnect();
  }, [host, key, workspace, generation, chart, ready, stocks, funds, dateTagged]);
}
