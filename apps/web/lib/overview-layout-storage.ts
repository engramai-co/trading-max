import { BREAKPOINTS, MEDIA_QUERIES } from "@/lib/breakpoints";
import { DISPLAY_LOCALE_STORAGE_KEY } from "@/lib/display-preferences";
import { PORTFOLIO_RANGES } from "@/lib/portfolio/history";
import type { Range } from "@/lib/portfolio/nav";
import { ledgerWidthClass, observeLedgerReservation } from "@/lib/overview-ledger-reservation";

export const OVERVIEW_LAYOUT_PREFIX = "mx-overview-layout-";
export const OVERVIEW_LAYOUT_VERSION_PREFIX = OVERVIEW_LAYOUT_PREFIX + "v3:";
const PREVIOUS_LAYOUT_VERSION_PREFIX = OVERVIEW_LAYOUT_PREFIX + "v2:";
export const OVERVIEW_LAYOUT_ACTIVE_KEY = "mx-active-overview-workspace";
export const OVERVIEW_LAYOUT_GENERATION_SUFFIX = ":generation";
export const OVERVIEW_LAYOUT_MEDIA = {
  narrow: MEDIA_QUERIES.narrow,
  phone: MEDIA_QUERIES.phone,
  tablet: "(max-width: " + BREAKPOINTS.tabletMax + "px)",
  compact: MEDIA_QUERIES.compactDesktop,
} as const;

export type LedgerRows = { stocks: number; funds: number; dateTagged?: number };
export type ReadingLayout = {
  range: Range;
  summary: number;
  history: number;
  plotTop?: number;
  disclosure?: { estimated: boolean; attribution: boolean };
};
export type LedgerWidth = "wide" | "stacked";
export type OverviewLayout = { rows: LedgerRows; ledger?: number; ledgerWidth?: LedgerWidth; reading?: ReadingLayout; sectors?: number; brief?: number };

const layoutBounds = {
  length: 512,
  rows: 500,
  ledgerBase: 2_000,
  ledgerPerRow: 400,
  ledgerCeiling: 200_000,
  panel: 2_000,
  plotOffset: 1_000,
  ranges: PORTFOLIO_RANGES as readonly string[],
};

/** This function is embedded in the head script too. Pass all dependencies explicitly. */
function validateLayout(raw: string | null | undefined, bounds: typeof layoutBounds): OverviewLayout | undefined {
  if (!raw || raw.length > bounds.length) return;
  try {
    const layout: OverviewLayout | null = JSON.parse(raw);
    if (!layout?.rows) return;
    const { stocks, funds, dateTagged } = layout.rows;
    if (!Number.isSafeInteger(stocks) || !Number.isSafeInteger(funds) || stocks < 0 || funds < 0) return;
    const count = stocks + funds;
    if (count > bounds.rows) return;
    const { ledger, ledgerWidth, reading, sectors, brief } = layout;
    const size = (value: number, max: number) => Number.isFinite(value) && value > 0 && value <= max;
    // Allow for wrapped rows at enlarged text sizes and a fixed amount for headings and the donut.
    const maxLedger = Math.min(bounds.ledgerCeiling, bounds.ledgerBase + bounds.ledgerPerRow * count);
    const valid: OverviewLayout = { rows: { stocks, funds } };
    if (dateTagged !== undefined && Number.isSafeInteger(dateTagged) && dateTagged > 0 && dateTagged <= count) {
      valid.rows.dateTagged = dateTagged;
    }
    if (ledger !== undefined && size(ledger, maxLedger)) {
      valid.ledger = ledger;
      if (valid.rows.dateTagged && (ledgerWidth === "wide" || ledgerWidth === "stacked")) valid.ledgerWidth = ledgerWidth;
    }
    if (sectors !== undefined && size(sectors, bounds.panel)) valid.sectors = sectors;
    if (brief !== undefined && size(brief, bounds.panel)) valid.brief = brief;
    if (!reading || !bounds.ranges.includes(reading.range) ||
        !size(reading.summary, bounds.panel) || !size(reading.history, bounds.panel)) return valid;
    const { range, summary, history, plotTop, disclosure } = reading;
    if (plotTop !== undefined && (!Number.isFinite(plotTop) || plotTop < 0 ||
        plotTop > Math.min(history, bounds.plotOffset))) return valid;
    valid.reading = { range, summary, history, plotTop };
    if (typeof disclosure?.estimated === "boolean" && typeof disclosure.attribution === "boolean") {
      valid.reading.disclosure = { estimated: disclosure.estimated, attribution: disclosure.attribution };
    }
    return valid;
  } catch {
    return undefined;
  }
}

export function parseOverviewLayout(raw: string | null | undefined) {
  return validateLayout(raw, layoutBounds);
}

/** Shared with the head script. Limit the cache to the current workspace's 30 supported keys. */
function prepareStorage(
  storage: Storage, legacy: Storage | undefined, prefix: string, workspace: string, previousWorkspace: string, key: string | undefined,
  validate: typeof validateLayout, bounds: typeof layoutBounds, generationSuffix: string,
) {
  const belongs = (name: string, owner = workspace) => name.startsWith(owner) &&
    /^(total|invest|isa):(zh|en):(narrow-phone|phone|tablet|compact|desktop)$/.test(name.slice(owner.length));
  // Counts are independent of the old spacing. The current ledger probe recalculates dimensions.
  const migrateRows = (source: Storage) => {
    for (const name of Object.keys(source)) {
      if (!belongs(name, previousWorkspace)) continue;
      if (source !== storage && storage.getItem(name + generationSuffix) !== null) continue;
      const target = workspace + name.slice(previousWorkspace.length);
      if (storage.getItem(target + generationSuffix) !== null || validate(storage.getItem(target), bounds)) continue;
      const entry = validate(source.getItem(name), bounds);
      if (entry) storage.setItem(target, JSON.stringify({ rows: entry.rows }));
    }
  };
  migrateRows(storage);
  if (legacy) {
    try { migrateRows(legacy); } catch {
      // Continue clearing outdated entries if tab storage is unavailable.
    }
  }
  for (const name of Object.keys(storage)) {
    const layoutKey = name.endsWith(generationSuffix) ? name.slice(0, -generationSuffix.length) : name;
    if (!name.startsWith(prefix) || belongs(layoutKey)) continue;
    // Later tabs may still have v2 session rows from before a confirmed clear.
    if (name !== layoutKey && belongs(layoutKey, previousWorkspace)) {
      const target = workspace + name.slice(previousWorkspace.length);
      const generation = storage.getItem(name);
      if (generation !== null && storage.getItem(target) === null) storage.setItem(target, generation);
    }
    storage.removeItem(name);
  }
  if (legacy) {
    try {
      for (const name of Object.keys(legacy)) {
        if (!name.startsWith(prefix)) continue;
        if (belongs(name) && storage.getItem(name + generationSuffix) === null && !validate(storage.getItem(name), bounds)) {
          const entry = validate(legacy.getItem(name), bounds);
          if (entry) storage.setItem(name, JSON.stringify(entry));
        }
        legacy.removeItem(name);
      }
    } catch {
      // Continue reading persisted entries if tab storage is unavailable.
    }
  }
  if (key === undefined) return;
  const raw = storage.getItem(key);
  const entry = validate(raw, bounds);
  if (entry) {
    const packed = JSON.stringify(entry);
    if (packed !== raw) {
      try { storage.setItem(key, packed); } catch {}
    }
  } else if (raw !== null) storage.removeItem(key);
  return entry;
}

export function isActiveOverviewWorkspace(workspace: string) {
  return localStorage.getItem(OVERVIEW_LAYOUT_ACTIVE_KEY) === workspace;
}

export function prepareOverviewLayoutStorage(workspace: string, key: string) {
  if (!isActiveOverviewWorkspace(workspace)) return;
  let legacy: Storage | undefined;
  try { legacy = window.sessionStorage; } catch {}
  const previousWorkspace = PREVIOUS_LAYOUT_VERSION_PREFIX + workspace.slice(OVERVIEW_LAYOUT_VERSION_PREFIX.length);
  return prepareStorage(window.localStorage, legacy, OVERVIEW_LAYOUT_PREFIX, workspace, previousWorkspace, key,
    validateLayout, layoutBounds, OVERVIEW_LAYOUT_GENERATION_SUFFIX);
}

/** Apply the same persistent layout the Overview will read after hydration. */
export function overviewLayoutInitScript(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) return "";
  const config = JSON.stringify({
    prefix: OVERVIEW_LAYOUT_PREFIX,
    workspace: OVERVIEW_LAYOUT_VERSION_PREFIX + scope + ":",
    previousWorkspace: PREVIOUS_LAYOUT_VERSION_PREFIX + scope + ":",
    activeKey: OVERVIEW_LAYOUT_ACTIVE_KEY,
    generationSuffix: OVERVIEW_LAYOUT_GENERATION_SUFFIX,
    localeKey: DISPLAY_LOCALE_STORAGE_KEY,
    media: OVERVIEW_LAYOUT_MEDIA,
    bounds: layoutBounds,
  });
  return `(function(config, validate, observeReservation, prepare, widthClass) {
  try {
    // Only a newly loaded workspace document can claim the cache.
    var changed = localStorage.getItem(config.activeKey) !== config.workspace;
    if (changed) localStorage.setItem(config.activeKey, config.workspace);
    var legacy;
    try { legacy = sessionStorage; } catch (error) {}
    if (!/^\\/(?:desktop\\/?)?$/.test(location.pathname)) {
      if (changed) prepare(localStorage, legacy, config.prefix, config.workspace, config.previousWorkspace,
        undefined, validate, config.bounds, config.generationSuffix);
      return;
    }
    var params = new URLSearchParams(location.search);
    var account = params.get("scope");
    if (account !== "invest" && account !== "isa") account = "total";
    var locale = "zh";
    try { if (localStorage.getItem(config.localeKey) === "en") locale = "en"; } catch (error) {}
    var media = config.media;
    var breakpoint = matchMedia(media.phone).matches
      ? matchMedia(media.narrow).matches ? "narrow-phone" : "phone"
      : matchMedia(media.tablet).matches ? "tablet" : matchMedia(media.compact).matches ? "compact" : "desktop";
    var root = document.documentElement;
    function applyMeasuredHeight(height) {
      if (height === undefined) {
        root.style.removeProperty("--mx-boot-ledger-height");
        root.removeAttribute("data-mx-boot-ledger-measured");
        return false;
      }
      root.style.setProperty("--mx-boot-ledger-height", height + "px");
      root.setAttribute("data-mx-boot-ledger-measured", "");
      return true;
    }
    function reserveRows(rows, entry) {
      if (typeof ResizeObserver !== "function" || typeof MutationObserver !== "function") return;
      var findProbe = new MutationObserver(function() {
        var probe = document.querySelector("[data-layout-bootstrap] .mx-ledger-probe");
        if (!probe || !probe.querySelector("[data-ledger-probe-ready]")) return;
        findProbe.disconnect();
        observeReservation(probe, root.style, "--mx-boot-ledger", rows, locale,
          function() { return probe.closest("[data-layout-bootstrap]") !== null; },
          function() {
            return applyMeasuredHeight(entry && entry.ledgerWidth && entry.ledgerWidth === widthClass(probe)
              ? entry.ledger : undefined);
          });
      });
      findProbe.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", function() { findProbe.disconnect(); }, { once: true });
    }
    var key = config.workspace + [account, locale, breakpoint].join(":");
    var entry = prepare(localStorage, legacy, config.prefix, config.workspace, config.previousWorkspace,
      key, validate, config.bounds, config.generationSuffix);
    if (!entry) {
      reserveRows({ stocks: 5, funds: 0 });
      return;
    }
    var stocks = entry.rows.stocks, funds = entry.rows.funds, count = stocks + funds;
    root.style.setProperty("--mx-boot-ledger-rows", String(count));
    root.style.setProperty("--mx-boot-ledger-groups", String(Number(stocks > 0) + Number(funds > 0)));
    root.setAttribute("data-mx-boot-ledger", count ? "rows" : "empty");
    if (entry.ledger !== undefined && !entry.rows.dateTagged) applyMeasuredHeight(entry.ledger);
    else if (count) reserveRows(entry.rows, entry);
    var reading = entry.reading;
    var range = params.get("range");
    if (!config.bounds.ranges.includes(range)) range = "1D";
    if (navigator.onLine && reading && reading.range === range) {
      root.style.setProperty("--mx-boot-summary-size", reading.summary + "px");
      root.style.setProperty("--mx-boot-history-size", reading.history + "px");
      var plot = reading.plotTop !== undefined;
      if (plot) root.style.setProperty("--mx-boot-plot-top", reading.plotTop + "px");
      if (reading.disclosure?.estimated) root.style.setProperty("--mx-boot-estimate-placeholder", "block");
      if (reading.disclosure?.attribution) root.style.setProperty("--mx-boot-attribution-placeholder", "block");
      root.setAttribute("data-mx-boot-history", plot ? "plot" : "empty");
    }
    if (navigator.onLine && entry.sectors !== undefined) {
      root.style.setProperty("--mx-boot-sectors-size", entry.sectors + "px");
      root.setAttribute("data-mx-boot-sectors", "");
    }
    if (navigator.onLine && entry.brief !== undefined) {
      root.style.setProperty("--mx-boot-brief-size", entry.brief + "px");
      root.style.setProperty("--mx-boot-brief-display", "block");
    }
  } catch (error) {}
})(${config}, ${validateLayout.toString()}, ${observeLedgerReservation.toString()}, ${prepareStorage.toString()}, ${ledgerWidthClass.toString()});`;
}
