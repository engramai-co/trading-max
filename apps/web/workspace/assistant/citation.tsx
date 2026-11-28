"use client";

import { ArrowRight } from "lucide-react";
import { useContext, useId, useRef, useState, type ComponentProps } from "react";
import { usePathname } from "next/navigation";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { overlayHoverDelay, overlayCloseDelay } from "@/components/ui/tooltip";
import { useLocale } from "@/components/locale-provider";
import { useFinePointer } from "@/ui/pointer";
import { useBreakpoint } from "@/lib/hooks";
import { presentationLink } from "../desktop-routing";
import Link from "../link";
import { isImeComposing } from "../shortcut-platform";
import { OverlayPopupContainer } from "../overlay";
import { citationPreview, sourceLabel, type Evidence } from "./evidence";
import { CitationReturnFocus, focusAssistantControl } from "./focus";
import { useAssistant } from "./context";
import { beginCitationNavigation } from "./highlight";

type Navigate = NonNullable<ComponentProps<typeof Link>["onNavigate"]>;

/** Follow the record actions alongside a reply with the same focus handoff as its citation. */
export function useAssistantRecordNavigation() {
  const pathname = usePathname();
  const {open, closeForCitation} = useAssistant();
  return (href: string) => {
    const route = presentationLink(pathname, href);
    if (route.separate) return;
    beginCitationNavigation(route.href);
    if (open && document.querySelector("#mx-assistant-panel[aria-modal='true']")) closeForCitation();
  };
}

export function Citation({ evidence, observation, onNavigate, container, onOpenLocalRecord }: {
  evidence: Evidence;
  observation?: string;
  container?: HTMLElement;
  onOpenLocalRecord?: () => boolean;
  onNavigate?: (event: Parameters<Navigate>[0], href: string) => void;
}) {
  const {locale, timeZone} = useLocale();
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const word = sourceLabel(evidence, t);
  const preview = citationPreview(evidence, locale, timeZone, observation);
  const pathname = usePathname();
  const fine = useFinePointer();
  const phone = useBreakpoint("phone");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const popupContainer = useContext(OverlayPopupContainer);
  const returnFocus = useContext(CitationReturnFocus);
  const trigger = useRef<HTMLButtonElement>(null);
  const record = useRef<HTMLElement>(null);
  const restoring = useRef(false);
  const restoreAfterDismiss = useRef<"keyboard" | "touch" | null>(null);
  const touchTrigger = useRef(false);
  if (!preview) return <span className="mx-reading-source">{word}</span>;

  const href = preview.href && phone && !preview.external ? phoneRecordHref(preview.href) : preview.href;
  const route = href ? presentationLink(pathname, href) : null;
  const newTab = preview.external || route?.separate;
  const tabHint = newTab ? t("（在新标签页中打开）", " (opens in a new tab)") : "";
  const actionName = id + "-action " + id + "-details";
  const openRecord = <>
    <span id={id + "-action"}>{t("打开记录", "Open record")}</span><ArrowRight size={16} aria-hidden="true" />
    <span hidden id={id + "-details"}>{preview.context + tabHint}</span>
  </>;
  function dismiss(restore?: "keyboard" | "touch") {
    setOpen(false);
    setUnavailable(false);
    if (!restore) return;
    // Restoring keyboard focus to the invoker must not reveal the dismissed preview again.
    restoring.current = true;
    focusAssistantControl(returnFocus(trigger.current, restore === "touch"));
    restoring.current = false;
  }
  return <Popover open={open} triggerId={id} onOpenChange={(next, change) => {
    if (change.reason === "escape-key") {
      if (change.event instanceof KeyboardEvent && isImeComposing(change.event)) {
        change.cancel();
        return;
      }
      restoreAfterDismiss.current = "keyboard";
    } else {
      restoreAfterDismiss.current = !next && change.reason === "trigger-press" && touchTrigger.current ? "touch" : null;
    }
    if (!next) setUnavailable(false);
    setOpen(next);
  }} onOpenChangeComplete={next => {
    if (next || !restoreAfterDismiss.current) return;
    const restore = restoreAfterDismiss.current;
    restoreAfterDismiss.current = null;
    dismiss(restore);
  }}>
    <PopoverTrigger ref={trigger} id={id} type="button" className="mx-reading-source"
      aria-labelledby={id + "-word " + id + "-context"} openOnHover={fine} delay={overlayHoverDelay} closeDelay={overlayCloseDelay}
      onPointerDown={event => { touchTrigger.current = event.pointerType === "touch"; }}
      onFocus={event => {
        if (!restoring.current && event.currentTarget.matches(":focus-visible")) setOpen(true);
      }}
      onKeyDown={event => {
        if (open && event.key === "Escape" && !isImeComposing(event.nativeEvent)) {
          event.stopPropagation();
          dismiss("keyboard");
          return;
        }
        if (!open || isImeComposing(event.nativeEvent)) return;
        if (event.key === "Enter" || event.key === " " || (event.key === "Tab" && !event.shiftKey)) {
          event.preventDefault();
          record.current?.focus();
        }
      }}>
      <span id={id + "-word"}>{word}</span><span hidden id={id + "-context"}>{preview.context + tabHint}</span>
    </PopoverTrigger>
    <PopoverContent container={container ?? popupContainer} className="mx-citation-preview" align="start" sideOffset={4}
      collisionAvoidance={{align:"shift"}}
      aria-label={preview.title} initialFocus={false} finalFocus={false}>
      <PopoverTitle className="mx-citation-title">{preview.title}{preview.date && " · " + preview.date}</PopoverTitle>
      {preview.scope && <p className="mx-citation-context">{preview.scope}</p>}
      {preview.fact && <p className="mx-citation-fact">{preview.fact}</p>}
      {preview.credit && <p className="mx-citation-context">{preview.credit}</p>}
      {!href || !route ? <>
        <button type="button" ref={node => { record.current = node; }} className="mx-citation-open"
          aria-labelledby={actionName} onClick={() => {
            if (onOpenLocalRecord?.()) dismiss();
            else setUnavailable(true);
          }}>{openRecord}</button>
        <p role="status" className={unavailable ? "mx-citation-context" : "sr-only"}>
          {unavailable ? t("引用的记录暂不可用", "Cited record unavailable") : ""}
        </p>
      </> : newTab ? <a ref={node => { record.current = node; }} className="mx-citation-open" aria-labelledby={actionName} href={route.href}
        target="_blank" rel="noreferrer" onClick={event => dismiss(event.detail === 0 ? "keyboard" : touchTrigger.current ? "touch" : undefined)}>{openRecord}</a>
        : <Link ref={node => { record.current = node; }} className="mx-citation-open" aria-labelledby={actionName} href={href} prefetch={false}
          onNavigate={event => {
            dismiss();
            onNavigate?.(event, route.href);
          }}>{openRecord}</Link>}
    </PopoverContent>
  </Popover>;
}

export function phoneRecordHref(href: string) {
  const [path, query] = href.split("?");
  const params = new URLSearchParams(query);
  // Keep the cited selection and snapshot, and open the underlying record on phones.
  if ((path === "/holdings" && params.get("view") === "lookthrough") || (path === "/analytics" && params.has("inspectFrom"))) {
    params.set("record", "1");
    return path + "?" + params;
  }
  return href;
}
