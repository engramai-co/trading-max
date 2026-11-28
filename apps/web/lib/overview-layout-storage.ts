import { BREAKPOINTS, MEDIA_QUERIES } from "@/lib/breakpoints";
import { DISPLAY_LOCALE_STORAGE_KEY } from "@/lib/display-preferences";
import { PORTFOLIO_RANGES } from "@/lib/portfolio/history";
import type { Range } from "@/lib/portfolio/nav";
import { observeLedgerReservation } from "@/lib/overview-ledger-reservation";

export const OVERVIEW_LAYOUT_PREFIX = "mx-overview-layout-";
export const OVERVIEW_LAYOUT_VERSION_PREFIX = OVERVIEW_LAYOUT_PREFIX + "v2:";
export const OVERVIEW_LAYOUT_MEDIA = {
  narrow: MEDIA_QUERIES.narrow,
  phone: MEDIA_QUERIES.phone,
  tablet: "(max-width: " + BREAKPOINTS.tabletMax + "px)",
  compact: MEDIA_QUERIES.compactDesktop,
} as const;

export type LedgerRows = { stocks: number; funds: number; dateTagged?: number };
export type ReadingLayout = { range: Range; summary: number; history: number; plotTop?: number };
export type OverviewLayout = { rows: LedgerRows; ledger?: number; reading?: ReadingLayout };

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
    const { ledger, reading } = layout;
    const size = (value: number, max: number) => Number.isFinite(value) && value > 0 && value <= max;
    // Allow for wrapped rows at enlarged text sizes and a fixed amount for headings and the donut.
    const maxLedger = Math.min(bounds.ledgerCeiling, bounds.ledgerBase + bounds.ledgerPerRow * count);
    const valid: OverviewLayout = { rows: { stocks, funds } };
    if (dateTagged !== undefined && Number.isSafeInteger(dateTagged) && dateTagged > 0 && dateTagged <= count) {
      valid.rows.dateTagged = dateTagged;
    }
    if (ledger !== undefined && size(ledger, maxLedger)) valid.ledger = ledger;
    if (!reading || !bounds.ranges.includes(reading.range) ||
        !size(reading.summary, bounds.panel) || !size(reading.history, bounds.panel)) return valid;
    const { range, summary, history, plotTop } = reading;
    if (plotTop !== undefined && (!Number.isFinite(plotTop) || plotTop < 0 ||
        plotTop > Math.min(history, bounds.plotOffset))) return valid;
    valid.reading = { range, summary, history, plotTop };
    return valid;
  } catch {
    return undefined;
  }
}

export function parseOverviewLayout(raw: string | null | undefined) {
  return validateLayout(raw, layoutBounds);
}

/** Apply the same tab-local layout the Overview will read after hydration. */
export function overviewLayoutInitScript(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) return "";
  const config = JSON.stringify({
    prefix: OVERVIEW_LAYOUT_VERSION_PREFIX + scope + ":",
    localeKey: DISPLAY_LOCALE_STORAGE_KEY,
    media: OVERVIEW_LAYOUT_MEDIA,
    bounds: layoutBounds,
  });
  return `(function(config, validate, observeReservation) {
  if (!/^\\/(?:desktop\\/?)?$/.test(location.pathname)) return;
  try {
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
    function reserveRows(rows) {
      if (typeof ResizeObserver !== "function" || typeof MutationObserver !== "function") return;
      var findProbe = new MutationObserver(function() {
        var probe = document.querySelector("[data-layout-bootstrap] .mx-ledger-probe");
        if (!probe || !probe.querySelector("[data-ledger-probe-ready]")) return;
        findProbe.disconnect();
        observeReservation(probe, root.style, "--mx-boot-ledger", rows, locale,
          function() { return probe.closest("[data-layout-bootstrap]") !== null; });
      });
      findProbe.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", function() { findProbe.disconnect(); }, { once: true });
    }
    var key = config.prefix + [account, locale, breakpoint].join(":");
    var raw = sessionStorage.getItem(key);
    var entry = validate(raw, config.bounds);
    if (!entry) {
      if (raw !== null) sessionStorage.removeItem(key);
      reserveRows({ stocks: 5, funds: 0 });
      return;
    }
    var stocks = entry.rows.stocks, funds = entry.rows.funds, count = stocks + funds;
    root.style.setProperty("--mx-boot-ledger-rows", String(count));
    root.style.setProperty("--mx-boot-ledger-groups", String(Number(stocks > 0) + Number(funds > 0)));
    root.setAttribute("data-mx-boot-ledger", count ? "rows" : "empty");
    if (entry.ledger !== undefined) {
      root.style.setProperty("--mx-boot-ledger-height", entry.ledger + "px");
      root.setAttribute("data-mx-boot-ledger-measured", "");
    } else if (count) reserveRows(entry.rows);
    var reading = entry.reading;
    var range = params.get("range");
    if (!config.bounds.ranges.includes(range)) range = "1D";
    if (navigator.onLine && reading && reading.range === range) {
      root.style.setProperty("--mx-boot-summary-size", reading.summary + "px");
      root.style.setProperty("--mx-boot-history-size", reading.history + "px");
      var plot = reading.plotTop !== undefined;
      if (plot) root.style.setProperty("--mx-boot-plot-top", reading.plotTop + "px");
      root.setAttribute("data-mx-boot-history", plot ? "plot" : "empty");
    }
    var packed = JSON.stringify(entry);
    if (packed !== raw) sessionStorage.setItem(key, packed);
  } catch (error) {}
})(${config}, ${validateLayout.toString()}, ${observeLedgerReservation.toString()});`;
}
