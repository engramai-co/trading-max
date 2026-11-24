"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { profileFreshFor, useWorkspaceProfile, workspaceProfileKey, workspaceProfileQuery } from "../profile";
import { api } from "../data";
import { withTimeoutSignal } from "../abort";
import { assistantSettingsChange, assistantSettingsKey, assistantStatusKey } from "../assistant-settings";
import type { AssistantSettings } from "@/lib/types";
import { desktopPage } from "../desktop-routing";
import { isImeComposing } from "../shortcut-platform";
import type { Reading } from "./evidence";

export type TurnObservation = {
  kind: string;
  evidenceId?: string;
  key?: string;
  field?: string;
  date?: string;
  end?: string;
  instant?: string;
  side?: "buy" | "sell";
  ordinal?: number;
};

export type PageTurnContext = {
  page: string;
  scope?: string;
  range?: string;
  start?: string;
  end?: string;
  benchmark?: string;
  ticker?: string;
  lens?: string;
  indexId?: string;
  market?: string;
  horizon?: string;
  habit?: string;
  snapshotId?: string;
  observation?: TurnObservation;
};
export type ResearchTurnContext = Pick<PageTurnContext, "ticker" | "lens" | "range" | "indexId">;
type ResearchChartLens = "overview" | "technical";
type ResearchChartWindows = Partial<Record<ResearchChartLens, { identity: string; range: string; snapshotId?: string }>>;

export type RoleCard = {
  role: string; title: string; object: string; questions: readonly string[]; reading?: Reading | null;
  status?: string; context?: Record<string, unknown>;
  pendingBinding?: boolean;
  origin?: { page: string; search: string; snapshotId?: string; research?: ResearchTurnContext };
};
const statusFreshFor = 30_000;
type Handoff = { card: RoleCard; draft: string; sequence: number };
type AssistantState = {
  open: boolean; ready: boolean; pending: boolean; suspended: boolean; consented: boolean; code: string | null; toggle: () => void; close: () => void;
  pageCard: RoleCard | null; setPageCard: (card: RoleCard | null) => void;
  pageContext: PageTurnContext | null;
  setPageContext: Dispatch<SetStateAction<PageTurnContext | null>>;
  researchChartWindows: ResearchChartWindows;
  setResearchChartWindows: Dispatch<SetStateAction<ResearchChartWindows>>;
  continueInSidebar: (card: RoleCard, draft?: string) => void; handoff: Handoff | null;
};
const Context = createContext<AssistantState | null>(null);
export function useOptionalAssistant() {
  return useContext(Context);
}
export function useAssistant() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing assistant workspace");
  return value;
}
/** Register a memoised opening card while its page or lens is mounted. */
export function usePageRole(card: RoleCard | null, register = true) {
  const { setPageCard } = useAssistant();
  useEffect(() => {
    if (!register) return;
    setPageCard(card);
    return () => setPageCard(null);
  }, [setPageCard, card, register]);
}
/** Register the selection shown by the mounted page, including retained data. */
export function useAssistantPageContext({
  page, scope, range, start, end, benchmark, ticker, lens, indexId, market, horizon, habit, snapshotId,
  observation,
}: PageTurnContext, register = true) {
  const { kind, evidenceId, key, field, date, end: observationEnd, instant, side, ordinal } = observation ?? {};
  const setPageContext = useOptionalAssistant()?.setPageContext;
  useEffect(() => {
    if (!register || !setPageContext) return;
    const selection = {
      page, scope, range, start, end, benchmark, ticker, lens, indexId, market, horizon, habit, snapshotId,
      observation: kind ? { kind, evidenceId, key, field, date, end: observationEnd, instant, side, ordinal } : undefined,
    };
    setPageContext(selection);
    return () => setPageContext(current => current === selection ? null : current);
  }, [setPageContext, register, page, scope, range, start, end, benchmark, ticker, lens, indexId, market,
    horizon, habit, snapshotId, kind, evidenceId, key, field, date, observationEnd, instant, side, ordinal]);
}

export function useResearchChartWindow(identity: string, lens: ResearchChartLens, range: string, snapshotId?: string) {
  const { setResearchChartWindows } = useAssistant();
  useEffect(() => {
    if (!identity || !range) return;
    const window = { identity, range, snapshotId };
    setResearchChartWindows(current => ({ ...current, [lens]: window }));
    return () => setResearchChartWindows(current =>
      current[lens] === window ? { ...current, [lens]: undefined } : current);
  }, [setResearchChartWindows, identity, lens, range, snapshotId]);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const profile = useWorkspaceProfile();
  const client = useQueryClient();
  const [pageCard, setPageCard] = useState<RoleCard | null>(null);
  const [pageContext, setPageContext] = useState<PageTurnContext | null>(null);
  const [researchChartWindows, setResearchChartWindows] = useState<ResearchChartWindows>({});
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
    queryFn: ({ signal }) => withTimeoutSignal(signal, 4000, (combined) =>
      api<{ ready: boolean; code: string | null }>("/assistant/status", { signal: combined, priority: "low" })),
    enabled: checkStatus, staleTime: statusFreshFor, retry: false, networkMode: "always",
  });
  const ready = checkStatus && !status.isError && Boolean(status.data?.ready);
  const consentDenied = optedIn === false || status.data?.code === "assistant_disabled" || status.data?.code === "assistant_consent_required";
  // Keep the local draft hidden through an outage or an unresolved profile.
  // Only a confirmed loss of consent discards it.
  const suspended = !ready && (waitingForConsent || !consentDenied);
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
    // Bypass the cached profile and use the workspace client's bounded retry for this check.
    const fresh = await client.query({...workspaceProfileQuery, staleTime:0}).catch(() => null);
    if (revision !== nextRevision.current || typeof fresh?.assistantEnabled !== "boolean") return;
    setConfirmedRevision(revision);
    void client.invalidateQueries({queryKey:assistantSettingsKey, exact:true});
  }, [client]);
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
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => { if (open) close(); else { revalidate(); setOpen(true); } }, [open, close, revalidate]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!isImeComposing(event) && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
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
  return <Context.Provider value={{ open, ready, suspended, consented: !waitingForConsent && optedIn === true && !consentDenied, pending: (waitingForConsent && !profile.isError) || profile.isPending || (checkStatus && (status.isPending || status.isFetching)), code: optedIn === false ? "assistant_disabled" : status.data?.code ?? null, toggle, close, pageCard, setPageCard, pageContext, setPageContext, researchChartWindows, setResearchChartWindows, continueInSidebar, handoff }}>
    {children}
  </Context.Provider>;
}
