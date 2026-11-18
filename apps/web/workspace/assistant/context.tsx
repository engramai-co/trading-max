"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { profileFreshFor, useWorkspaceProfile, workspaceProfileKey } from "../profile";
import { api } from "../data";
import { assistantSettingsChange, assistantSettingsKey, assistantStatusKey } from "../assistant-settings";
import type { AssistantSettings } from "@/lib/types";
import { desktopPage } from "../desktop-routing";
import type { Reading } from "./evidence";

export type RoleCard = {
  role: string; title: string; object: string; questions: readonly string[]; reading?: Reading | null;
  status?: string; context?: Record<string, unknown>;
  origin?: { page: string; search: string; snapshotId?: string };
};
const statusFreshFor = 30_000;
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
  const profile = useWorkspaceProfile();
  const client = useQueryClient();
  const [pageCard, setPageCard] = useState<RoleCard | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  // Settings writes through this shared query key. A new revision immediately
  // gates visible content and requests a fresh readiness check.
  const settings = useQuery<AssistantSettings>({
    queryKey: assistantSettingsKey, queryFn: ({ signal }) => api("/settings/assistant", { signal }), enabled: false,
  });
  const optedIn = profile.data?.assistantEnabled ??
    (settings.data && settings.data.enabled && settings.data.acceptedConsentRevision === settings.data.consentRevision);
  // Earlier servers only expose readiness via status. Resolve it on explicit open.
  const checkStatus = optedIn === true || (optedIn === undefined && open && !profile.isPending);
  const status = useQuery({ queryKey: [...assistantStatusKey, settings.data?.revision ?? null],
    queryFn: ({ signal }) => api<{ ready: boolean; code: string | null }>("/assistant/status", { signal, priority: "low" }),
    enabled: checkStatus, staleTime: statusFreshFor, retry: false,
  });
  const ready = checkStatus && !status.isError && Boolean(status.data?.ready);
  const revalidate = useCallback((changed = false) => {
    const now = Date.now();
    if (changed || now - profile.dataUpdatedAt >= profileFreshFor) {
      void client.invalidateQueries({queryKey:workspaceProfileKey, exact:true});
    }
    if (changed || (checkStatus && now - status.dataUpdatedAt >= statusFreshFor)) {
      void client.invalidateQueries({queryKey:assistantStatusKey}, {cancelRefetch:changed});
    }
    if (changed) void client.invalidateQueries({queryKey:assistantSettingsKey, exact:true});
  }, [client, profile.dataUpdatedAt, checkStatus, status.dataUpdatedAt]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    const changed = (event: StorageEvent) => { if (event.key === assistantSettingsChange) revalidate(true); };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revalidate]);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-assistant-trigger]")?.focus({ preventScroll: true }));
  }, []);
  const toggle = useCallback(() => { if (open) close(); else { revalidate(); setOpen(true); } }, [open, close, revalidate]);
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
    revalidate();
    const page = (desktopPage(location.pathname) ?? location.pathname.slice(1)) || "overview";
    const origin = card.origin ?? {page, search: location.search, snapshotId: card.reading?.snapshotId ?? undefined};
    setHandoff(previous => ({ card: {...card, origin}, draft, sequence: (previous?.sequence ?? 0) + 1 }));
    setOpen(true);
  }
  return <Context.Provider value={{ open, ready, pending: profile.isPending || (checkStatus && (status.isPending || status.isFetching)), code: optedIn === false ? "assistant_disabled" : status.data?.code ?? null, toggle, close, pageCard, setPageCard, continueInSidebar, handoff }}>
    {children}
  </Context.Provider>;
}
