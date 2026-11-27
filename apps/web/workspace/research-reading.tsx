"use client";

import { useLocalStorage } from "@/lib/hooks";
import { Pin } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useCopy } from "./foundation";
import { Plot } from "./plot";
import { useRouteState } from "./route-state";

export const valuationSections = [
  ["history", "历史估值", "Historical valuation"],
  ["scenario", "情景模型", "Scenario model"],
  ["sensitivity", "敏感性", "Sensitivity"],
  ["worksheet", "计算底稿", "Worksheet"],
] as const;

export const analystSections = [
  ["ratings", "评级与目标价", "Ratings & targets"],
  ["forecast", "业绩预期", "Earnings estimates"],
  ["events", "财报事件", "Earnings events"],
  ["actions", "机构行动", "Institutional actions"],
] as const;

// Ids keep the former sub-tab values, so existing links open the same content.
export const technicalSections = [
  ["price", "走势", "Price"],
  ["data", "技术诊断", "Technical diagnosis"],
  ["seasonality", "季节性", "Seasonality"],
] as const;

export const financialSections = [
  ["performance", "经营分析", "Operating analysis"],
  ["income", "利润表", "Income"],
  ["balance", "资产负债表", "Balance sheet"],
  ["cash", "现金流量表", "Cash flow"],
  ["business", "业务分部", "Segments"],
  ["ownership", "股权与分红", "Ownership & dividends"],
  ["full", "完整报表", "All reported rows"],
] as const;

type Section = readonly [id: string, zh: string, en: string];

function OutlineIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="4" cy="4.5" r="2" />
    <circle cx="4" cy="11.5" r="2" />
    <path d="M8.5 4.5h5.5M8.5 11.5h5.5" />
  </svg>;
}

export function ResearchReading({ sections, parameter, children, before, initial }: {
  sections: readonly Section[];
  parameter: "analystView" | "valuationView" | "technicalView" | "financialMode";
  children: ReactNode;
  before?: ReactNode;
  /** The section a legacy route opens when it names none. */
  initial?: string;
}) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const legacySection = parameter === "valuationView"
    ? params.has("estimateRef") && "scenario"
    : parameter === "analystView"
      ? (params.has("forecastPeriod") || params.has("estimateFrequency")) && "forecast"
      : initial;
  const requested = params.get(parameter) ?? legacySection;
  const ids = sections.map(([id]) => id).join(",");
  const [active, setActive] = useState(sections[0][0]);
  const nav = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const ticker = params.get("ticker");
  const pending = useRef<string | null>(null);
  const pinned = useRef<string | null>(null);
  const focusedHeading = useRef<HTMLElement | null>(null);
  // Wide layouts give the reading the full width: the index is hidden or floats over the page
  // unless the reader pins it to its own column.
  const [indexOpen, setIndexOpen] = useLocalStorage({ key: "mx-research-index-open", defaultValue: false });
  const [indexPinned, setIndexPinned] = useLocalStorage({ key: "mx-research-index-pinned", defaultValue: false });
  const indexMode = !indexOpen ? "closed" : indexPinned ? "pin" : "float";
  const indexId = useId();
  const visitSection = useCallback((id: string) => {
    const section = document.getElementById("research-" + id);
    const heading = section?.querySelector<HTMLElement>("h2");
    if (!section || !heading) return false;
    focusedHeading.current = heading;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start", behavior: "instant" });
    pinned.current = id;
    setActive(id);
    return true;
  }, []);

  // A route can arrive before its section (for example the model worksheet).
  // A later preview may change the available sections without requesting another jump.
  useEffect(() => {
    // Tabs and filters keep their focus. Opening the same URL as a bookmark
    // has no local history state and focuses the requested section.
    pending.current = window.history.state?.focusResearchSection === false ? null : requested || null;
    pinned.current = null;
    focusedHeading.current = null;
  }, [parameter, requested, ticker]);

  useEffect(() => {
    const sectionIds = ids.split(",");
    let frame = 0;
    let inputScrollY: number | null = null;
    const measure = () => {
      frame = 0;
      if (pending.current && sectionIds.includes(pending.current) && visitSection(pending.current)) {
        pending.current = null;
      }
      if (pinned.current) {
        // The first heading may be replaced or move behind the loaded results.
        // Follow it only if the reader still has focus on the original heading.
        const previous = focusedHeading.current;
        if (previous && (document.activeElement === previous ||
          (!previous.isConnected && document.activeElement === document.body))) {
          const heading = document.getElementById("research-" + pinned.current)?.querySelector<HTMLElement>("h2");
          if (heading && heading !== previous) {
            focusedHeading.current = heading;
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }
        }
        return;
      }
      const present = sectionIds.map((id) => document.getElementById("research-" + id)).filter((target) => target !== null);
      if (!present.length) return;
      const threshold = parseFloat(getComputedStyle(present[0]).scrollMarginTop) + Math.min(window.innerHeight * 0.1, 80);
      const reached = present.filter((target) => target.getBoundingClientRect().top <= threshold);
      const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      const current = (atEnd ? present.at(-1) : reached.at(-1)) ?? present[0];
      setActive(current.id.slice("research-".length));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    // Scroll anchoring and a shorter document can change scrollY without reader input.
    const resumeTracking = () => {
      pinned.current = null;
      pending.current = null;
      focusedHeading.current = null;
      schedule();
    };
    const noteInput = (direction: number) => {
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // A gesture against the page boundary cannot cause a later layout scroll.
      inputScrollY = (direction < 0 && y <= 0) || (direction > 0 && y >= max - 1) ? null : y;
    };
    const keyIntent = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
      if (["ArrowUp", "Home", "PageUp"].includes(event.key)) noteInput(-1);
      else if (["ArrowDown", "End", "PageDown"].includes(event.key)) noteInput(1);
      else if (event.key === " ") noteInput(event.shiftKey ? -1 : 1);
    };
    const wheelIntent = (event: WheelEvent) => { if (event.deltaY && !event.ctrlKey) noteInput(event.deltaY); };
    let touchY = 0;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0].clientY; };
    const touchIntent = (event: TouchEvent) => {
      const y = event.touches[0].clientY;
      if (y !== touchY) noteInput(touchY - y);
      touchY = y;
    };
    const scrollbarIntent = (event: PointerEvent) => {
      if (event.target === document.documentElement) noteInput(0);
    };
    const onScroll = () => {
      if (inputScrollY != null && inputScrollY !== window.scrollY) {
        inputScrollY = null;
        resumeTracking();
      }
      schedule();
    };
    const focusChanged = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === focusedHeading.current) return;
      focusedHeading.current = null;
      const section = target.closest('[id^="research-"]');
      if (section && pinned.current && section.id !== "research-" + pinned.current) resumeTracking();
    };
    schedule();
    const listeners = new AbortController();
    const passive = { signal: listeners.signal, passive: true };
    window.addEventListener("wheel", wheelIntent, passive);
    window.addEventListener("touchstart", touchStart, passive);
    window.addEventListener("touchmove", touchIntent, passive);
    window.addEventListener("keydown", keyIntent, passive);
    window.addEventListener("focusin", focusChanged, passive);
    window.addEventListener("pointerdown", scrollbarIntent, passive);
    window.addEventListener("scroll", onScroll, passive);
    const observer = new ResizeObserver(schedule);
    if (content.current) observer.observe(content.current);
    if (nav.current) observer.observe(nav.current);
    return () => {
      listeners.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ids, parameter, requested, ticker, visitSection]);

  useEffect(() => {
    const bar = nav.current;
    const item = bar?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!bar || !item || bar.scrollWidth <= bar.clientWidth) return;
    const bounds = bar.getBoundingClientRect(), link = item.getBoundingClientRect();
    if (link.left < bounds.left) bar.scrollLeft += link.left - bounds.left;
    else if (link.right > bounds.right) bar.scrollLeft += link.right - bounds.right;
  }, [active]);

  return <div className="mx-reading-container">
    <div className="mx-reading-layout" data-index={indexMode}>
      <div className="mx-section-rail">
      <div className="mx-section-panel">
        <div className="mx-section-tools">
          {indexOpen && <button type="button" className="mx-section-pin" aria-pressed={indexPinned}
            aria-label={t("固定本页分节", "Pin sections")} title={indexPinned ? t("取消固定", "Unpin") : t("固定", "Pin")}
            onClick={() => setIndexPinned((pinned) => !pinned)}>
            <Pin size={16} fill={indexPinned ? "currentColor" : "none"} aria-hidden="true" />
          </button>}
        <button type="button" className="mx-section-toggle" aria-expanded={indexOpen} aria-controls={indexId}
          aria-label={t("本页分节", "Sections on this page")} title={indexOpen ? t("收起分节", "Hide sections") : t("展开分节", "Show sections")}
          onClick={() => setIndexOpen((open) => !open)}>
          <OutlineIcon />
        </button>
        </div>
      <nav id={indexId} ref={nav} className="mx-section-index" aria-label={t("本页分节", "On this page")}>
        {sections.map(([id, zh, en]) => {
          const next = new URLSearchParams(params.toString());
          next.set(parameter, id);
          return <a key={id} href={"?" + next.toString()} aria-current={id === active ? "location" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (requested === id) visitSection(id);
              else update({ [parameter]: id });
            }}>{t(zh, en)}</a>;
        })}
      </nav>
      </div>
      </div>
      <div ref={content} className="mx-reading-sections">{before}{children}</div>
    </div>
  </div>;
}

/** Reserve the plot's space until the reader approaches it, including inside disclosures. */
export function DeferredPlot(props: ComponentProps<typeof Plot>) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "100px 0px" });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} style={{ minHeight: props.height ?? 300 }}>{visible && <Plot {...props} />}</div>;
}

/** True once the section approaches the viewport, or at once when a link asks for it. */
export function useApproached(requested: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const near = seen || requested;
  useEffect(() => {
    if (near) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [near]);
  return [box, near] as const;
}
