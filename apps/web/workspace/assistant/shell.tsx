"use client";

import { FocusTrap } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
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
  const { open, close } = useAssistant();
  const [visited, setVisited] = useState(false);
  if (open && !visited) setVisited(true);
  const overlay = useMediaQuery("(max-width: 1199px)");
  useEffect(() => {
    if (!open || searchOpen) return;
    function escape(e: KeyboardEvent) { if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); close(); } }
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    if (overlay) document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", escape); if (overlay) document.body.style.overflow = previous; };
  }, [close, open, overlay, searchOpen]);
  if (!visited) return null;
  return <FocusTrap active={Boolean(open && overlay && !searchOpen)}><aside id="mx-assistant-panel" className="mx-assistant-panel" hidden={!open}
    role={overlay ? "dialog" : "complementary"} aria-modal={overlay && open || undefined} aria-label={ASSISTANT_NAME}>
    <Sidebar {...{ page, search, scopeLabel }} />
  </aside></FocusTrap>;
}
