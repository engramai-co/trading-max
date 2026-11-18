"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { profileFreshFor, useWorkspaceProfile, workspaceProfileKey } from "../profile";
import { api } from "../data";
import { assistantSettingsChange, assistantSettingsKey, assistantStatusKey } from "../assistant-settings";
import type { AssistantSettings } from "@/lib/types";
import { desktopPage } from "../desktop-routing";
import type { Reading } from "./evidence";

export type RoleCard = {
  role: string; title: string; object: string; questions: readonly string[]; reading?: Reading | null;
  context?: Record<string, unknown>;
  origin?: { page: string; search: string; snapshotId?: string };
};
const statusFreshFor = 30_000;
type Handoff = { card: RoleCard; draft: string; sequence: number };
type AssistantState = {
  open: boolean; ready: boolean; pending: boolean; suspended: boolean; consented: boolean; code: string | null; toggle: () => void; close: () => void;
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
  const nextRevision = useRef(0);
  const [externalRevision, setExternalRevision] = useState(0);
  const [confirmedRevision, setConfirmedRevision] = useState(0);
  const waitingForConsent = confirmedRevision !== externalRevision;
  const legacyConsent = settings.data && settings.data.enabled && settings.data.acceptedConsentRevision === settings.data.consentRevision;
  const optedIn = profile.data?.assistantEnabled ?? (externalRevision === 0 ? legacyConsent : undefined);
  // Older servers expose readiness via status on an explicit open. A cross-window
  // settings change always requires fresh, positive consent from the profile.
  const checkStatus = !waitingForConsent && (optedIn === true ||
    (externalRevision === 0 && optedIn === undefined && open && !profile.isPending));
  const status = useQuery({ queryKey: [...assistantStatusKey, settings.data?.revision ?? null, externalRevision],
    queryFn: ({ signal }) => api<{ ready: boolean; code: string | null }>("/assistant/status", { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), priority: "low" }),
    enabled: checkStatus, staleTime: statusFreshFor, retry: false, networkMode: "always",
  });
  const ready = checkStatus && !status.isError && Boolean(status.data?.ready);
  const refetchProfile = profile.refetch;
  const confirmConsent = useCallback(async () => {
    const revision = ++nextRevision.current;
    setExternalRevision(revision);
    await Promise.all([
      client.cancelQueries({queryKey:assistantStatusKey}),
      client.cancelQueries({queryKey:["assistant-conversations"]}),
      client.cancelQueries({queryKey:["assistant-reading"]}),
      client.cancelQueries({queryKey:workspaceProfileKey, exact:true}),
    ]);
    if (revision !== nextRevision.current) return;
    const fresh = await refetchProfile();
    if (revision !== nextRevision.current || !fresh.isSuccess) return;
    setConfirmedRevision(revision);
    void client.invalidateQueries({queryKey:assistantSettingsKey, exact:true});
  }, [client, refetchProfile]);
  const revalidate = useCallback(() => {
    if (waitingForConsent) {
      if (!profile.isFetching) void confirmConsent();
      return;
    }
    const now = Date.now();
    if (now - profile.dataUpdatedAt >= profileFreshFor) {
      void client.invalidateQueries({queryKey:workspaceProfileKey, exact:true});
    }
    if (checkStatus && now - status.dataUpdatedAt >= statusFreshFor) {
      void client.invalidateQueries({queryKey:assistantStatusKey}, {cancelRefetch:false});
    }
  }, [client, profile.dataUpdatedAt, profile.isFetching, checkStatus, status.dataUpdatedAt, waitingForConsent, confirmConsent]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    const changed = (event: StorageEvent) => { if (event.key === assistantSettingsChange) void confirmConsent(); };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revalidate, confirmConsent]);
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
  return <Context.Provider value={{ open, ready, suspended: waitingForConsent, consented: !waitingForConsent && optedIn === true && status.data?.code !== "assistant_disabled", pending: (waitingForConsent && !profile.isError) || profile.isPending || (checkStatus && (status.isPending || status.isFetching)), code: optedIn === false ? "assistant_disabled" : status.data?.code ?? null, toggle, close, pageCard, setPageCard, continueInSidebar, handoff }}>
    {children}
  </Context.Provider>;
}
