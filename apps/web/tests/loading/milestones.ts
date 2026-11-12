import { ticker } from "./fixtures";

type Signal = { selector: string; text?: string; inViewport?: boolean };
const signal = (selector: string, text?: string): Signal => ({ selector, text });
const viewport = (selector: string, text?: string): Signal => ({ selector, text, inViewport: true });
const ready = "[data-tm-chart-ready=true]";
const date = "[0-9]";
const activeTab = (name: string) => signal('main [role=tab][aria-selected=true]', name);

type Scenario = {
  name: string;
  url: string;
  rail?: string;
  tab?: string;
  first: Signal;
  toolbar: Signal[];
  placeholder: Signal[];
  figure: Signal[];
  charts: Signal[];
};

export const scenarios: Scenario[] = [
  {
    name: "Overview", url: "/",
    first: viewport(".mx-summary-top"),
    toolbar: [viewport(".mx-summary-top")],
    placeholder: [signal(".mx-overview-portfolio .mx-loading-summary"), signal(".mx-overview-history .mx-loading-chart"),
      signal(".mx-overview-sectors .mx-loading-sectors"), signal(".mx-overview-holdings .mx-loading-holdings")],
    figure: [viewport(".mx-overview-totals .mx-number", "£[0-9]"), viewport(".mx-summary-top .mx-freshness", date)],
    charts: [signal(".mx-overview-history " + ready), signal(".mx-overview-sector-map .mx-overview-sector"),
      signal(".mx-ledger-donut svg path")],
  },
  {
    name: "Holdings", url: "/holdings",
    first: viewport(".mx-holdings-summary .mx-toolbar"),
    toolbar: [activeTab("^(Your positions|直接持仓)$"), viewport(".mx-holdings-summary .mx-toolbar"), viewport(".mx-holdings-list .mx-toolbar")],
    placeholder: [signal(".mx-holdings-summary .mx-loading-summary"), signal(".mx-holdings-list .mx-loading-holdings")],
    figure: [viewport(".mx-holdings-summary .mx-number", "£[0-9]"), viewport(".mx-holdings-summary .mx-freshness", date)],
    charts: [],
  },
  {
    name: "Look-through", url: "/holdings?view=lookthrough", rail: "/holdings", tab: "Look-through exposure",
    first: viewport('main [role=tab][aria-selected=true]', "^(Look-through exposure|穿透底层资产)$"),
    toolbar: [activeTab("^(Look-through exposure|穿透底层资产)$")],
    placeholder: [signal("main .mx-loading-holdings")],
    figure: [viewport(".mx-exposure-basis > span", "[0-9]+ underlying securities"),
      viewport(".mx-exposure-basis .mx-freshness", date)],
    charts: [],
  },
  {
    name: "Money", url: "/analytics?view=money", rail: "/analytics",
    first: viewport(".mx-analytics-toolbar"),
    toolbar: [activeTab("^(Money & P&L|资金与盈亏)$"), viewport(".mx-analytics-toolbar"), viewport(".mx-chart-toolbar")],
    placeholder: [signal(".mx-loading-analytics")],
    figure: [viewport(".mx-money-summary .mx-number", "£[0-9]"), viewport(".mx-analytics-toolbar .mx-freshness", date)],
    charts: [signal(".mx-money-timeline " + ready)],
  },
  {
    name: "Returns", url: "/analytics?view=returns", rail: "/analytics", tab: "Return comparison",
    first: viewport('main [role=tab][aria-selected=true]', "^(Return comparison|收益对比)$"),
    toolbar: [activeTab("^(Return comparison|收益对比)$"), viewport(".mx-analytics-toolbar"), viewport(".mx-chart-toolbar")],
    placeholder: [signal(".mx-loading-analytics")],
    figure: [viewport(".mx-chart-metrics .mx-number", "[0-9]%"), viewport(".mx-analytics-toolbar .mx-freshness", date)],
    charts: [signal('main [aria-label="Returns and drawdowns on a shared timeline"]' + ready)],
  },
  {
    name: "Markets", url: "/sectors",
    first: viewport(".mx-sectors-bar"),
    toolbar: [viewport(".mx-sectors-bar")],
    placeholder: [signal(".mx-sectors-page .mx-loading-generic")],
    figure: [viewport(".mx-sector-detail-change", "[0-9]%"), viewport(".mx-sectors-clock", "As of .*" + date)],
    charts: [signal(".mx-sector-map .mx-sector-block"), signal(".mx-sector-detail .mx-sector-spark-line")],
  },
  {
    name: "Research", url: "/research?ticker=" + ticker + "&view=overview", rail: "/research",
    first: viewport(".mx-research-page .mx-universe-toggle, .mx-research-page .mx-security-header"),
    toolbar: [viewport(".mx-security-header"), signal('main [role=tab][aria-selected=true][aria-label="Overview"]')],
    placeholder: [signal(".mx-research-wait .mx-loading-chart")],
    figure: [viewport(".mx-security-price strong", date), viewport(".mx-quote-as-of small", date)],
    charts: [signal(".mx-price-diagnosis-preview " + ready)],
  },
  {
    name: "Review", url: "/review",
    first: viewport("main .mx-page-heading h1", "^(Investment review|投资复盘)$"),
    toolbar: [viewport("main .mx-page-heading h1", "^(Investment review|投资复盘)$")],
    placeholder: [signal(".mx-loading-review")],
    figure: [viewport(".mx-account-card .mx-number", "£[0-9]"), viewport(".mx-page-heading .mx-freshness", date)],
    charts: [],
  },
  {
    name: "Health", url: "/health",
    first: viewport(".mx-health-page .mx-page-heading h1"),
    toolbar: [viewport(".mx-health-page .mx-page-heading h1"), viewport(".mx-health-page .mx-page-actions button")],
    placeholder: [signal(".mx-health-page .mx-loading-generic")],
    figure: [viewport(".mx-health-hero h2", "^Your data service is ready$"), viewport(".mx-health-hero .mx-freshness", date)],
    charts: [],
  },
];

export const moments = ["firstContent", "structure", "figure", "charts"] as const;
export type Sample = Record<typeof moments[number], number | null>;
type ProbeState = { result: Sample; start: number | null; stop: () => void };
type ProbeWindow = Window & { __loadingBenchmark?: ProbeState };

export function installProbe({ scenario, railClick }: { scenario: Scenario; railClick?: string }) {
  const scope = window as ProbeWindow;
  scope.__loadingBenchmark?.stop();
  let frame = 0;
  const probe: ProbeState = {
    result: { firstContent: null, structure: null, figure: null, charts: null },
    start: railClick ? null : 0,
    stop() {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("click", begin, true);
    },
  };
  scope.__loadingBenchmark = probe;

  function begin(event: MouseEvent) {
    if (!(event.target instanceof Element) || !event.target.closest(railClick!)) return;
    // Arm at the actual input event, before Next.js or React handles it.
    probe.start = performance.now();
    window.removeEventListener("click", begin, true);
  }
  if (railClick) window.addEventListener("click", begin, true);

  const visible = ({ selector, text, inViewport }: Signal) => Array.from(document.querySelectorAll(selector)).some((el) => {
    if (text && !new RegExp(text).test(el.textContent ?? "")) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0
      && (!inViewport || box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight);
  });
  const target = new URL(scenario.url, location.origin);
  function observe() {
    frame = window.requestAnimationFrame(observe);
    if (probe.start === null || location.pathname !== target.pathname) return;
    if (scenario.tab && (location.search !== target.search || !visible(scenario.first))) return;
    const { result, start } = probe;
    const now = performance.now() - start;
    const all = (signals: Signal[]) => signals.every(visible);
    if (result.firstContent === null) {
      result.firstContent = railClick
        ? visible(scenario.first) ? now : null
        : performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime ?? null;
    }
    // A fast result can replace its skeleton before the first visible frame.
    // Accept the real content in the same phase instead of requiring a loading flash.
    const figureVisible = (result.figure === null || result.structure === null) && all(scenario.figure);
    if (result.structure === null && all(scenario.toolbar) && (all(scenario.placeholder) || figureVisible)) result.structure = now;
    if (result.figure === null && figureVisible) result.figure = now;
    if (result.charts === null && scenario.charts.length && all(scenario.charts)) result.charts = now;
    if (result.firstContent !== null && result.structure !== null && result.figure !== null
      && (!scenario.charts.length || result.charts !== null)) {
      // The browser can calculate layout before it presents the first content.
      // A DOM candidate observed that early cannot be visible before native FCP.
      if (!railClick) {
        const fcp = result.firstContent;
        result.structure = Math.max(result.structure, fcp);
        result.figure = Math.max(result.figure, fcp);
        if (result.charts !== null) result.charts = Math.max(result.charts, fcp);
      }
      probe.stop();
    }
  }
  frame = window.requestAnimationFrame(observe);
}
