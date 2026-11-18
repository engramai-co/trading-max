"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
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

type Section = readonly [id: string, zh: string, en: string];

export function ResearchReading({ sections, parameter, children, before }: {
  sections: readonly Section[];
  parameter: "analystView" | "valuationView";
  children: ReactNode;
  before?: ReactNode;
}) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const legacySection = parameter === "valuationView"
    ? params.has("estimateRef") && "scenario"
    : (params.has("forecastPeriod") || params.has("estimateFrequency")) && "forecast";
  const requested = params.get(parameter) ?? legacySection;
  const ids = sections.map(([id]) => id).join(",");
  const [active, setActive] = useState(sections[0][0]);
  const nav = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const jump = useRef<{ id: string; y: number } | null>(null);
  const visitSection = useCallback((id: string) => {
    const section = document.getElementById("research-" + id);
    const heading = section?.querySelector<HTMLElement>("h2");
    if (!section || !heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start", behavior: "instant" });
    jump.current = { id, y: window.scrollY };
  }, []);

  useEffect(() => {
    const sectionIds = ids.split(",");
    jump.current = null;
    if (requested && sectionIds.includes(requested)) visitSection(requested);
    let frame = 0;
    const measure = () => {
      frame = 0;
      // At the end of a short page, several headings can share a scroll position.
      if (jump.current && Math.abs(window.scrollY - jump.current.y) <= 1) {
        setActive(jump.current.id);
        return;
      }
      jump.current = null;
      const present = sectionIds.map((id) => document.getElementById("research-" + id)).filter((target) => target !== null);
      if (!present.length) return;
      const threshold = parseFloat(getComputedStyle(present[0]).scrollMarginTop) + Math.min(window.innerHeight * 0.1, 80);
      const reached = present.filter((target) => target.getBoundingClientRect().top <= threshold);
      const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      const current = (atEnd ? present.at(-1) : reached.at(-1)) ?? present[0];
      setActive(current.id.slice("research-".length));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    if (content.current) observer.observe(content.current);
    if (nav.current) observer.observe(nav.current);
    return () => {
      window.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ids, requested, visitSection]);

  useEffect(() => {
    const bar = nav.current;
    const item = bar?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!bar || !item || bar.scrollWidth <= bar.clientWidth) return;
    const bounds = bar.getBoundingClientRect(), link = item.getBoundingClientRect();
    if (link.left < bounds.left) bar.scrollLeft += link.left - bounds.left;
    else if (link.right > bounds.right) bar.scrollLeft += link.right - bounds.right;
  }, [active]);

  return <div className="mx-reading-container">
    <div className="mx-reading-layout">
      <nav ref={nav} className="mx-section-index" aria-label={t("本页分节", "On this page")}>
        {sections.map(([id, zh, en]) => {
          const next = new URLSearchParams(params.toString());
          next.set(parameter, id);
          return <a key={id} href={"?" + next.toString()} aria-current={id === active ? "location" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (requested === id) {
                visitSection(id);
                setActive(id);
              } else update({ [parameter]: id });
            }}>{t(zh, en)}</a>;
        })}
      </nav>
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
