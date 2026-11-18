"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import Link from "../link";
import { useCopy } from "../foundation";
import { errorLabel } from "./status-label";
import { ASSISTANT_NAME } from "../assistant-settings";
import { useAssistant } from "./context";
import { focusAssistantControl } from "./focus";

const Sidebar = dynamic(() => import("./sidebar"), { ssr: false });

function cyclePanelTab(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:enabled, textarea:enabled, [tabindex]"))
    .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0);
  if (!controls.length) return;
  event.preventDefault();
  const index = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
  focusAssistantControl(controls[next]);
}

export function AssistantEntry() {
  const { open, toggle } = useAssistant();
  return <button type="button" data-assistant-trigger className="mx-assistant-trigger" aria-expanded={open} aria-controls="mx-assistant-panel" aria-keyshortcuts="Meta+J Control+J" onClick={toggle}>
    <span aria-hidden="true">✦</span> {ASSISTANT_NAME} <kbd>⌘J</kbd>
  </button>;
}
export function AssistantPanel({ page, search, scopeLabel, searchOpen, overlay }: { overlay: boolean; page: string; search: string; scopeLabel: string; searchOpen: boolean }) {
  const { open, close, ready, pending, suspended, code } = useAssistant();
  const t = useCopy();
  // A new opening requires confirmation. An already visible thread can keep its
  // draft editable while readiness refreshes. A consent signal immediately clears ready.
  const [thread, setThread] = useState<"unvisited" | "hidden" | "visible">("unvisited");
  if (open && ready && !pending && thread !== "visible") setThread("visible");
  else if ((!open || !ready) && thread === "visible") setThread("hidden");
  const showThread = thread === "visible";
  useEffect(() => {
    if (!open || searchOpen) return;
    function escape(e: KeyboardEvent) { if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); close(); } }
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    if (overlay) document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", escape); if (overlay) document.body.style.overflow = previous; };
  }, [close, open, overlay, searchOpen]);
  const wasOpen = useRef(false);
  const needsOpeningFocus = useRef(false);
  const [composer, setComposer] = useState<HTMLTextAreaElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastControl = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (open !== wasOpen.current) {
      needsOpeningFocus.current = open;
      if (open && composer) lastControl.current = composer;
      if (!open) focusAssistantControl(document.querySelector<HTMLElement>("[data-assistant-trigger]"));
    }
    wasOpen.current = open;
    if (!ready && !pending && !suspended) lastControl.current = null;
    if (!open || searchOpen) return;
    const active = document.activeElement;
    // An explicit open can precede the lazy composer. A non-modal panel leaves background focus alone.
    if (!needsOpeningFocus.current && !overlay && active && active !== document.body && !panel.current?.contains(active)) return;
    // The lazy thread can mount its Close button one render before its composer ref arrives.
    if (needsOpeningFocus.current && showThread && !composer && !lastControl.current) return;
    const dismiss = panel.current?.querySelectorAll<HTMLElement>("[data-assistant-dismiss]") ?? [];
    if (focusAssistantControl(lastControl.current, composer, ...dismiss)) needsOpeningFocus.current = false;
  }, [open, overlay, pending, ready, suspended, searchOpen, composer, showThread]);
  if (thread === "unvisited" && !open) return null;
  return <div ref={panel} id="mx-assistant-panel" className="mx-assistant-panel" hidden={!open}
    onKeyDown={overlay && !searchOpen ? cyclePanelTab : undefined}
    role={overlay ? "dialog" : "complementary"} aria-modal={overlay && open || undefined} aria-label={ASSISTANT_NAME}>
    {(ready || pending || suspended) && thread !== "unvisited" && <div className="mx-assistant-thread" hidden={!showThread}
      onFocusCapture={event => { lastControl.current = event.target; }}><Sidebar {...{ page, search, scopeLabel }} checking={showThread && pending} composerRef={setComposer} /></div>}
    {!showThread && <>
      <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><button data-assistant-dismiss onClick={close}
        onKeyDown={event => { if (pending && event.key === "Tab") event.preventDefault(); }}
        aria-label={t("关闭侧栏","Close sidebar")}><X /></button></div>
      <div className="mx-assistant-opening"><p>{pending ? t("正在检查连接…","Checking connection…") : errorLabel(code ?? "assistant_unavailable", t)}</p>
        {!pending && <Link href="/settings?tab=assistant" prefetch={false} onClick={close} className="mx-text-link">{t("打开设置","Open Settings")} →</Link>}
      </div>
    </>}
  </div>;
}
