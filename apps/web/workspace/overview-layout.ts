"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore, type RefObject } from "react";
import type { Locale } from "@/components/locale-provider";
import { useMediaQuery } from "@/lib/hooks";
import {
  OVERVIEW_LAYOUT_MEDIA,
  OVERVIEW_LAYOUT_PREFIX,
  OVERVIEW_LAYOUT_VERSION_PREFIX,
  parseOverviewLayout,
  type LedgerRows,
  type OverviewLayout,
  type ReadingLayout,
} from "@/lib/overview-layout-storage";
import type { Range, Scope } from "@/lib/portfolio/nav";
import { useSnapshotCacheScope } from "@/ui/snapshot-cache-provider";

const subscribe = () => () => {};
const serverSnapshot = () => undefined;
const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The tab remembers only row counts, geometry and range. The ledger still flows with the page. */
export function useOverviewLayout(account: Scope, locale: Locale) {
  const workspace = useSnapshotCacheScope();
  const phone = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.phone);
  const narrow = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.narrow);
  const singleColumn = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.tablet);
  const compact = useMediaQuery(OVERVIEW_LAYOUT_MEDIA.compact);
  const breakpoint = phone ? narrow ? "narrow-phone" : "phone" : singleColumn ? "tablet" : compact ? "compact" : "desktop";
  const workspacePrefix = workspace ? OVERVIEW_LAYOUT_VERSION_PREFIX + workspace + ":" : undefined;
  // Each workspace can write at most 3 accounts × 2 locales × 5 breakpoints.
  const key = workspacePrefix ? workspacePrefix + [account, locale, breakpoint].join(":") : undefined;
  const getSnapshot = useCallback(() => {
    try { return key ? sessionStorage.getItem(key) : null; } catch { return null; }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const layout = useMemo(() => parseOverviewLayout(raw), [raw]);
  useLayoutEffect(() => {
    if (!workspacePrefix) return;
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(OVERVIEW_LAYOUT_PREFIX) && !key.startsWith(workspacePrefix)) sessionStorage.removeItem(key);
      }
    } catch {
      // The page also works with storage disabled.
    }
  }, [workspacePrefix]);
  useLayoutEffect(() => {
    if (!key || raw == null) return;
    try {
      if (sessionStorage.getItem(key) !== raw) return;
      if (!layout) sessionStorage.removeItem(key);
      else {
        const packed = JSON.stringify(layout);
        if (packed !== raw) sessionStorage.setItem(key, packed);
      }
    } catch {
      // Ignore storage failures and use the default placeholder.
    }
  }, [key, raw, layout]);
  return { key, layout, booting: raw === undefined };
}

export function useSaveOverviewLayout(
  host: RefObject<HTMLDivElement | null>,
  key: string | undefined,
  chart: { selection: { range: Range }; history?: object } | undefined,
  ready: boolean,
  rows: LedgerRows | undefined,
) {
  const stocks = rows?.stocks;
  const funds = rows?.funds;
  const dateTagged = rows?.dateTagged;
  useLayoutEffect(() => {
    const root = host.current;
    if (!ready || !root || !key || stocks === undefined || funds === undefined) return;
    const summary = root.querySelector<HTMLElement>(".mx-overview-portfolio");
    const history = root.querySelector<HTMLElement>(".mx-overview-history");
    const plot = history?.querySelector<HTMLElement>(".mx-plot");
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
        };
      }
      const layout: OverviewLayout = { rows: { stocks, funds, dateTagged }, ledger: ledgerHeight, reading };
      try {
        const validated = parseOverviewLayout(JSON.stringify(layout));
        if (!validated) {
          sessionStorage.removeItem(key);
          return;
        }
        const value = JSON.stringify(validated);
        if (sessionStorage.getItem(key) !== value) sessionStorage.setItem(key, value);
      } catch {
        // The live page and its count-based skeleton also work with storage disabled.
      }
    };
    const observer = new ResizeObserver(save);
    [summary, history, plot, ledger].forEach((element) => { if (element) observer.observe(element); });
    save();
    return () => observer.disconnect();
  }, [host, key, chart, ready, stocks, funds, dateTagged]);
}
