"use client";

import { FocusTrap } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import Link from "../link";
import { useCopy } from "../foundation";
import { errorLabel } from "./status-label";
import { ASSISTANT_NAME } from "../assistant-settings";
import { useAssistant } from "./context";

const Sidebar = dynamic(() => import("./sidebar"), { ssr: false });
export function AssistantEntry() {
  const { open, toggle } = useAssistant();
  return <button type="button" data-assistant-trigger className="mx-assistant-trigger" aria-expanded={open} aria-controls="mx-assistant-panel" aria-keyshortcuts="Meta+J Control+J" onClick={toggle}>
    <span aria-hidden="true">✦</span> {ASSISTANT_NAME} <kbd>⌘J</kbd>
  </button>;
}
export function AssistantPanel({ page, search, scopeLabel, searchOpen }: { page: string; search: string; scopeLabel: string; searchOpen: boolean }) {
  const { open, close, ready, pending, code } = useAssistant();
  const t = useCopy();
  const [visited, setVisited] = useState(false);
  if (open && ready && !pending && !visited) setVisited(true);
  const overlay = useMediaQuery("(max-width: 1199px)");
  useEffect(() => {
    if (!open || searchOpen) return;
    function escape(e: KeyboardEvent) { if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); close(); } }
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    if (overlay) document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", escape); if (overlay) document.body.style.overflow = previous; };
  }, [close, open, overlay, searchOpen]);
  const panel = useRef<HTMLDivElement>(null);
  const lastControl = useRef<HTMLElement>(null);
  const gateClose = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) { lastControl.current = null; return; }
    if (searchOpen) return;
    const active = document.activeElement;
    // A non-modal desktop panel may revalidate while the reader is working elsewhere.
    if (active && active !== document.body && !panel.current?.contains(active) && !active.matches("[data-assistant-trigger]")) return;
    if (pending || !ready) {
      gateClose.current?.focus({preventScroll:true});
      if (!pending) lastControl.current = null;
    } else if (lastControl.current?.isConnected) {
      lastControl.current.focus({preventScroll:true});
    }
  }, [open, pending, ready, searchOpen]);
  if (!visited && !open) return null;
  return <FocusTrap innerRef={panel} active={Boolean(open && overlay && !searchOpen)}><div id="mx-assistant-panel" className="mx-assistant-panel" hidden={!open}
    role={overlay ? "dialog" : "complementary"} aria-modal={overlay && open || undefined} aria-label={ASSISTANT_NAME}>
    {ready && visited && <div className="mx-assistant-thread" hidden={pending}
      onFocusCapture={event => { lastControl.current = event.target; }}><Sidebar {...{ page, search, scopeLabel }} /></div>}
    {(!ready || pending) && <>
      <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><button ref={gateClose} onClick={close}
        onKeyDown={event => { if (pending && event.key === "Tab") event.preventDefault(); }}
        aria-label={t("关闭侧栏","Close sidebar")}><X /></button></div>
      <div className="mx-assistant-opening"><p>{pending ? t("正在检查连接…","Checking connection…") : errorLabel(code ?? "assistant_unavailable", t)}</p>
        {!pending && <Link href="/settings?tab=assistant" prefetch={false} onClick={close} className="mx-text-link">{t("打开设置","Open Settings")} →</Link>}
      </div>
    </>}
  </div></FocusTrap>;
}
