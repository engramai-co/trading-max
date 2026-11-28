"use client";

import dynamic from "next/dynamic";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import Link from "../link";
import { StatusMessage, useCopy } from "../foundation";
import { Button } from "@/components/ui/button";
import { WorkspacePersistentSheet } from "../overlay";
import { isImeComposing } from "../shortcut-platform";
import { errorLabel } from "./status-label";
import { ASSISTANT_NAME } from "../assistant-settings";
import { useAssistant } from "./context";
import { canFocusAssistantControl, CitationReturnFocus, focusAssistantControl } from "./focus";

const Sidebar = dynamic(() => import("./sidebar"), { ssr: false });

const subscribePlatform = () => () => {};
const isApplePlatform = () => /Macintosh|MacIntel|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function AssistantEntry() {
  const { open, toggle } = useAssistant();
  const apple = useSyncExternalStore(subscribePlatform, isApplePlatform, () => false);
  return <button type="button" data-assistant-trigger className="mx-assistant-trigger" aria-expanded={open} aria-controls="mx-assistant-panel" aria-keyshortcuts={apple ? "Meta+J" : "Control+J"} onClick={toggle}>
    <span aria-hidden="true">✦</span> {ASSISTANT_NAME} <kbd>{apple ? "⌘J" : "Ctrl+J"}</kbd>
  </button>;
}
export function AssistantPanel({ page, scopeLabel, searchOpen, overlay }: { overlay: boolean; page: string; scopeLabel: string; searchOpen: boolean }) {
  const { open, close, toggle, ready, pending, suspended, code, handoff, retryStatus, consumeCitationDismissal } = useAssistant();
  const t = useCopy();
  const keyboardOpen = useRef(false);
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    const ownsModifier = isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.defaultPrevented || searchOpen || !ownsModifier || event.altKey || event.shiftKey ||
        isImeComposing(event) || event.key.toLowerCase() !== "j") return;
    const alert = document.querySelector('[role="alertdialog"]:not([hidden]):not([data-closed])');
    if (alert) return;
    event.preventDefault();
    if (!event.repeat) {
      keyboardOpen.current = !open;
      toggle();
    }
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => shortcut(event);
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  // A new opening requires confirmation. An already visible thread can keep its
  // draft editable while readiness refreshes. A consent signal immediately clears ready.
  const [thread, setThread] = useState<"unvisited" | "hidden" | "visible">("unvisited");
  if (open && ready && !pending && thread !== "visible") setThread("visible");
  else if ((!open || !ready) && thread === "visible") setThread("hidden");
  const showThread = thread === "visible";
  const wasOpen = useRef(false);
  const focusedHandoff = useRef(0);
  const needsOpeningFocus = useRef(false);
  const restoreDraftCaret = useRef(false);
  const [composer, setComposer] = useState<HTMLTextAreaElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastControl = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement>(null);
  const wasModal = useRef(overlay);
  const wasReady = useRef(false);
  const wasInsidePanel = useRef(false);
  useEffect(() => {
    function trackFocus(event: FocusEvent) {
      if (open && !overlay && event.target instanceof HTMLElement && event.target !== document.body && !panel.current?.contains(event.target)) {
        wasInsidePanel.current = false;
      }
    }
    document.addEventListener("focusin", trackFocus);
    return () => document.removeEventListener("focusin", trackFocus);
  }, [open, overlay]);
  useLayoutEffect(() => {
    if (open !== wasOpen.current) {
      needsOpeningFocus.current = open;
      restoreDraftCaret.current = open;
      wasInsidePanel.current = false;
      if (open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (composer && (!overlay || keyboardOpen.current)) lastControl.current = composer;
      }
    }
    const enteredModal = open && overlay && !wasModal.current;
    const recovered = open && showThread && !wasReady.current && wasInsidePanel.current;
    const withdrawn = open && !ready && !pending && !suspended && wasReady.current && wasInsidePanel.current;
    if (enteredModal || recovered || withdrawn) needsOpeningFocus.current = true;
    const focusComposer = !overlay || enteredModal || recovered || keyboardOpen.current ||
      !window.matchMedia("(pointer: coarse)").matches;
    wasOpen.current = open;
    wasModal.current = overlay;
    wasReady.current = showThread;
    if (!ready && !pending && !suspended) lastControl.current = null;
    if (!open || searchOpen) return;
    if (handoff && handoff.sequence !== focusedHandoff.current && showThread) {
      const target = overlay && handoff.touch
        ? panel.current?.querySelector<HTMLElement>("[data-assistant-dismiss]")
        : composer;
      if (focusAssistantControl(target)) {
        focusedHandoff.current = handoff.sequence;
        needsOpeningFocus.current = false;
        keyboardOpen.current = false;
        return;
      }
    }
    const active = document.activeElement;
    if (showThread && active && active !== document.body) wasInsidePanel.current = Boolean(panel.current?.contains(active));
    // An explicit open can precede the lazy composer. A non-modal panel leaves background focus alone.
    if (!needsOpeningFocus.current) {
      if (active instanceof HTMLElement && active !== document.body && canFocusAssistantControl(active)) return;
      // Tab can legitimately leave the dock while readiness is being checked.
      if (!overlay && !showThread && !pending) return;
    }
    // The lazy thread can mount its Close button one render before its composer ref arrives.
    if (focusComposer && showThread && !composer && (keyboardOpen.current || needsOpeningFocus.current)) return;
    const focusPanel = () => {
      const dismiss = panel.current?.querySelectorAll<HTMLElement>("[data-assistant-dismiss]") ?? [];
      const focused = focusComposer
        ? focusAssistantControl(lastControl.current, composer, ...dismiss)
        : focusAssistantControl(...dismiss);
      if (focused && showThread) keyboardOpen.current = false;
      if (!focused) return false;
      if (restoreDraftCaret.current && composer && document.activeElement === composer) {
        composer.setSelectionRange(composer.value.length, composer.value.length);
        restoreDraftCaret.current = false;
      }
      needsOpeningFocus.current = false;
      return true;
    };
    if (!focusPanel() && needsOpeningFocus.current) {
      const frame = requestAnimationFrame(() => {
        if (needsOpeningFocus.current) focusPanel();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!showThread && !overlay) needsOpeningFocus.current = false;
  }, [open, overlay, pending, ready, suspended, searchOpen, composer, showThread, handoff]);
  if (thread === "unvisited" && !open) return null;
  const settingsIssue = code === "assistant_disabled" || code === "assistant_consent_required" ||
    code === "provider_auth_failed" || code === "provider_not_configured";
  return <WorkspacePersistentSheet open={open} modal={overlay} onClose={() => { if (!searchOpen) close(); }}
    label={ASSISTANT_NAME} initialFocus={false} finalFocus={() => {
      if (consumeCitationDismissal()) return false;
      const active = document.activeElement;
      if (active && active !== document.body && !panel.current?.contains(active)) return false;
      return opener.current?.isConnected && !opener.current.matches(":disabled, body")
        ? opener.current : document.querySelector<HTMLElement>("[data-assistant-trigger]");
    }}>
    <CitationReturnFocus.Provider value={(source, touch) => touch && overlay
      ? panel.current?.querySelector<HTMLElement>("[data-assistant-dismiss]") ?? source
      : source}>
    <div className="mx-assistant-thread" ref={panel}>
      {(ready || pending || suspended) && thread !== "unvisited" && <div className="mx-assistant-thread" hidden={!showThread}
        onFocusCapture={event => {
        if (event.target instanceof HTMLElement) {
          lastControl.current = event.target;
          wasInsidePanel.current = true;
        }
      }}><Sidebar {...{ page, scopeLabel }} checking={showThread && pending} composerRef={setComposer} /></div>}
      {!showThread && <>
        <div className="mx-assistant-heading"><strong><span className="mx-assistant-spark" aria-hidden="true">✦</span>{ASSISTANT_NAME}</strong>
          <Button variant="ghost" size="icon" tabIndex={0} data-assistant-dismiss onClick={close} aria-label={t("关闭侧栏","Close sidebar")}><X size={20} aria-hidden="true" /></Button></div>
        <div className="mx-assistant-opening">
          <p><StatusMessage className="" message={pending ? t("正在检查连接…","Checking connection…") : settingsIssue
            ? errorLabel(code ?? "assistant_unavailable", t) : t("暂时无法检查连接。", "Could not check the connection.")} /></p>
          {!pending && (settingsIssue
            ? <Link tabIndex={0} href="/settings?tab=assistant" prefetch={false} onClick={close} className="mx-text-link">{t("打开设置","Open Settings")}</Link>
            : <Button tabIndex={0} variant="secondary" onClick={retryStatus}>{t("重试", "Retry")}</Button>)}
        </div>
      </>}
    </div>
    </CitationReturnFocus.Provider>
  </WorkspacePersistentSheet>;
}
