"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../data";
import { assistantSettingsKey } from "../assistant-settings";
import type { AssistantSettings } from "@/lib/types";
import { desktopPage } from "../desktop-routing";
import type { Reading } from "./evidence";

export type RoleCard = {
  role: string; title: string; object: string; questions: readonly string[]; reading?: Reading | null;
  context?: Record<string, unknown>;
  pendingBinding?: boolean;
  origin?: { page: string; search: string; snapshotId?: string };
};
type Handoff = { card: RoleCard; draft: string; sequence: number };
type AssistantState = {
  open: boolean; ready: boolean; pending: boolean; code: string | null; toggle: () => void; close: () => void;
  pageCard: RoleCard | null; setPageCard: (card: RoleCard | null) => void;
  continueInSidebar: (card: RoleCard, draft?: string) => void; handoff: Handoff | null;
};
const Context = createContext<AssistantState | null>(null);
export function useAssistant() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing assistant workspace");
  return value;
}
/** Register a memoised opening card while its page or lens is mounted. */
export function usePageRole(card: RoleCard | null) {
  const { setPageCard } = useAssistant();
  useEffect(() => {
    setPageCard(card);
    return () => setPageCard(null);
  }, [setPageCard, card]);
}
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setPainted(true)); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const [pageCard, setPageCard] = useState<RoleCard | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  // Settings writes through this shared query key. A new revision immediately
  // gates visible content and requests a fresh readiness check.
  const settings = useQuery<AssistantSettings>({
    queryKey: assistantSettingsKey, queryFn: ({ signal }) => api("/settings/assistant", { signal }), enabled: false,
  });
  const status = useQuery({ queryKey: ["assistant-status", settings.data?.revision ?? null],
    queryFn: ({ signal }) => api<{ ready: boolean; code: string | null }>("/assistant/status", { signal, priority: "low" }),
    enabled: painted || open, staleTime: 30_000, retry: false,
  });
  const ready = !status.isError && Boolean(status.data?.ready) && (!settings.data || settings.data.enabled && settings.data.acceptedConsentRevision === settings.data.consentRevision);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-assistant-trigger]")?.focus({ preventScroll: true }));
  }, []);
  const toggle = useCallback(() => { if (open) close(); else setOpen(true); }, [open, close]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (!event.repeat) toggle();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [toggle]);
  function continueInSidebar(card: RoleCard, draft = "") {
    if (!ready) return;
    const page = (desktopPage(location.pathname) ?? location.pathname.slice(1)) || "overview";
    const origin = card.origin ?? {page, search: location.search, snapshotId: card.reading?.snapshotId ?? undefined};
    setHandoff(previous => ({ card: {...card, origin}, draft, sequence: (previous?.sequence ?? 0) + 1 }));
    setOpen(true);
  }
  return <Context.Provider value={{ open, ready, pending: status.isPending, code: status.data?.code ?? null, toggle, close, pageCard, setPageCard, continueInSidebar, handoff }}>
    {children}
  </Context.Provider>;
}
