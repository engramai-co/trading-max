"use client";

import { buttonVariants } from "@/components/ui/button";
import { Tip } from "./foundation";
import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";

export const railLink = buttonVariants({ variant: "ghost", size: "icon", className: "mx-nav-link" });

export function NavigationHint({ label, children }: { label: ReactNode; children: ReactElement<Record<string, unknown>> }) {
  return <Tip label={label} position="right" offset={12} describes={false} decorative>
    {children}
  </Tip>;
}

export function NavigationIcon({ icon: Glyph }: { icon: LucideIcon }) {
  return <span className="mx-nav-icon">
    <Glyph size={20} aria-hidden="true" />
  </span>;
}

// Share one interruptible background across the vertical rail and mobile dock.
// Measure only the active link, never charts or every scroll frame.
export function NavigationGroup({ activeHref, children }: { activeHref?: string; children: ReactNode }) {
  const group = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ href: string; left: number; top: number; width: number; height: number } | null>(null);
  const pointerRoute = useRef(false);
  useEffect(() => {
    const reset = () => {
      pointerRoute.current = false;
      if (group.current) delete group.current.dataset.motion;
    };
    window.addEventListener("popstate", reset);
    return () => window.removeEventListener("popstate", reset);
  }, []);
  useLayoutEffect(() => {
    const active = group.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    const element = indicator.current;
    if (!active || !element || !activeHref) {
      previous.current = null;
      pointerRoute.current = false;
      if (group.current) {
        delete group.current.dataset.indicator;
        delete group.current.dataset.motion;
      }
      return;
    }
    const bounds = () => ({ left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight });
    const box = bounds();
    const place = (next: ReturnType<typeof bounds>) => {
      const transform = `translate(${next.left}px, ${next.top}px)`;
      element.style.transform = transform;
      element.style.width = `${next.width}px`;
      element.style.height = `${next.height}px`;
      return transform;
    };
    const old = previous.current;
    const start = getComputedStyle(element).transform;
    element.getAnimations().forEach((animation) => animation.cancel());
    const target = place(box);
    group.current!.dataset.indicator = "true";
    const motion = pointerRoute.current;
    if (!motion) delete group.current!.dataset.motion;
    if (motion && old && old.href !== activeHref) {
      element.animate([{ transform: start }, { transform: target }], {
        duration: 150, easing: "cubic-bezier(.16,1,.3,1)",
      });
    }
    previous.current = { href: activeHref, ...box };
    pointerRoute.current = false;
    const observer = new ResizeObserver(() => {
      const next = bounds();
      if (previous.current?.left === next.left && previous.current?.top === next.top && previous.current?.width === next.width && previous.current?.height === next.height) return;
      element.getAnimations().forEach((animation) => animation.cancel());
      place(next);
      previous.current = { href: activeHref, ...next };
    });
    observer.observe(group.current!);
    return () => observer.disconnect();
  }, [activeHref]);
  return <div className="mx-nav-group" ref={group}
    onClickCapture={(event) => {
      const link = (event.target as HTMLElement).closest("a");
      // Reduced motion never arms the slide. Deciding here, before the route
      // renders, keeps the measurement below from starting it.
      pointerRoute.current = Boolean(link && !link.hasAttribute("aria-current") && event.detail > 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (pointerRoute.current) event.currentTarget.dataset.motion = "pointer";
      else delete event.currentTarget.dataset.motion;
    }}
    onKeyDownCapture={(event) => { pointerRoute.current = false; delete event.currentTarget.dataset.motion; }}>
    <span ref={indicator} className="mx-nav-indicator" aria-hidden="true" />
    {children}
  </div>;
}
