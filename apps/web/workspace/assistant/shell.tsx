"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Link from "../link";
import { StatusMessage, useCopy } from "../foundation";
import { Dialog, DialogOverlay, DialogPortal, DialogSurface } from "@/components/ui/dialog";
import { isImeComposing } from "../shortcut-platform";
import { errorLabel } from "./status-label";
import { ASSISTANT_NAME } from "../assistant-settings";
import { useAssistant } from "./context";
import { focusAssistantControl } from "./focus";

const Sidebar = dynamic(() => import("./sidebar"), { ssr: false });

export function AssistantEntry() {
  const { open, toggle } = useAssistant();
  return <button type="button" data-assistant-trigger className="mx-assistant-trigger" aria-expanded={open} aria-controls="mx-assistant-panel" aria-keyshortcuts="Meta+J Control+J" onClick={toggle}>
    <span aria-hidden="true">✦</span> {ASSISTANT_NAME} <kbd>⌘J</kbd>
  </button>;
}
export function AssistantPanel({ page, scopeLabel, searchOpen, overlay }: { overlay: boolean; page: string; scopeLabel: string; searchOpen: boolean }) {
  const { open, close, ready, pending, suspended, code, handoff } = useAssistant();
  const t = useCopy();
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
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const lastControl = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (open !== wasOpen.current) {
      needsOpeningFocus.current = open;
      restoreDraftCaret.current = open;
      if (open && composer) lastControl.current = composer;
    }
    wasOpen.current = open;
    if (!ready && !pending && !suspended) lastControl.current = null;
    if (!open || searchOpen) return;
    if (handoff && handoff.sequence !== focusedHandoff.current && showThread && focusAssistantControl(composer)) {
      focusedHandoff.current = handoff.sequence;
      needsOpeningFocus.current = false;
      return;
    }
    const active = document.activeElement;
    // An explicit open can precede the lazy composer. A non-modal panel leaves background focus alone.
    if (!needsOpeningFocus.current && !overlay && active && active !== document.body && !panel?.contains(active)) return;
    // The lazy thread can mount its Close button one render before its composer ref arrives.
    if (needsOpeningFocus.current && showThread && !composer && !lastControl.current) return;
    const focusPanel = () => {
      const dismiss = panel?.querySelectorAll<HTMLElement>("[data-assistant-dismiss]") ?? [];
      if (!focusAssistantControl(lastControl.current, composer, ...dismiss)) return false;
      if (restoreDraftCaret.current && composer && document.activeElement === composer) {
        composer.setSelectionRange(composer.value.length, composer.value.length);
        restoreDraftCaret.current = false;
      }
      needsOpeningFocus.current = false;
      return true;
    };
    if (!focusPanel() && needsOpeningFocus.current) {
      const frame = requestAnimationFrame(focusPanel);
      return () => cancelAnimationFrame(frame);
    }
  }, [open, overlay, pending, ready, suspended, searchOpen, composer, showThread, handoff, panel]);
  if (thread === "unvisited" && !open) return null;
  return <Dialog open={open} modal={overlay} disablePointerDismissal onOpenChange={(next, { event, cancel }) => {
    if (next) return;
    if (searchOpen || (event instanceof KeyboardEvent && (event.defaultPrevented || isImeComposing(event)))) {
      cancel();
      return;
    }
    close();
  }}>
    <DialogPortal keepMounted>
      {overlay && <DialogOverlay />}
      <DialogSurface ref={setPanel} id="mx-assistant-panel" className="mx-assistant-panel"
        role={overlay ? "dialog" : "complementary"} aria-modal={overlay || undefined} aria-label={ASSISTANT_NAME}
        initialFocus={false} finalFocus={() => document.querySelector<HTMLElement>("[data-assistant-trigger]")}>
        {(ready || pending || suspended) && thread !== "unvisited" && <div className="mx-assistant-thread" hidden={!showThread}
          onFocusCapture={event => { lastControl.current = event.target; }}><Sidebar {...{ page, scopeLabel }} checking={showThread && pending} composerRef={setComposer} /></div>}
        {!showThread && <>
          <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><button tabIndex={0} data-assistant-dismiss onClick={close}
            aria-label={t("关闭侧栏","Close sidebar")}><X size={18} aria-hidden="true" /></button></div>
          <div className="mx-assistant-opening"><p><StatusMessage className="" message={pending ? t("正在检查连接…", "Checking connection…") : errorLabel(code ?? "assistant_unavailable", t)} /></p>
            {!pending && <Link tabIndex={0} href="/settings?tab=assistant" prefetch={false} onClick={close} className="mx-text-link">{t("打开设置","Open Settings")} →</Link>}
          </div>
        </>}
      </DialogSurface>
    </DialogPortal>
  </Dialog>;
}
