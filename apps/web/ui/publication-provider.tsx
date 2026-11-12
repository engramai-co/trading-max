"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { publicationFromHealth, watchPublications } from "@/lib/publication";
import { refreshPublicationQueries } from "@/lib/publication-queries";
import { webBuildHeader, webBuildId } from "@/lib/web-build";
import { isWorkspacePath } from "@/workspace/desktop-routing";
import type { HealthDetails } from "@/lib/types";

type PublicationStatus = {
  failed: boolean;
  retry: () => void;
  navigateBuild: (href: string, preventDefault?: () => void) => boolean;
  draftGuards: Set<symbol>;
};
const PublicationContext = createContext<PublicationStatus | null>(null);

export function PublicationProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const pendingBuild = useRef<string | null>(null);
  const [draftGuards] = useState(() => new Set<symbol>());
  const [failed, setFailed] = useState(false);
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    const watcher = watchPublications(async (signal) => {
      // Activity already reads the same health payload, often from a 5s poll.
      const existing = client.getQueryState<HealthDetails>(["workspace-health"]);
      if (existing?.status === "success" && existing.data?.health &&
          (!webBuildId || existing.data.buildId) && Date.now() - existing.dataUpdatedAt < 15_000) {
        return { ...publicationFromHealth(existing.data.health), buildId: existing.data.buildId };
      }
      const response = await fetch("/api/backend/health", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Publication check failed");
      return { ...publicationFromHealth(await response.json()), buildId: response.headers.get(webBuildHeader) };
    }, (publication) => {
      if (publication.buildId && webBuildId) {
        pendingBuild.current = publication.buildId === webBuildId ? null : publication.buildId;
      }
      setFailed(false);
      if (publication.runId) void refreshPublicationQueries(client, publication.runId);
    }, (failures) => {
      // One dropped check on a flaky network isn't news; a second in a row is.
      if (failures >= 2) setFailed(true);
    }, () => document.visibilityState === "visible");
    retry.current = watcher.retry;
    const wake = watcher.wake;
    window.addEventListener("focus", wake);
    // Browser connectivity hints can wake a check, but only the request decides
    // whether the selected service is reachable. A local service works offline.
    window.addEventListener("online", watcher.retry);
    window.addEventListener("offline", wake);
    document.addEventListener("visibilitychange", wake);
    wake();
    return () => {
      watcher.dispose();
      retry.current = () => {};
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", watcher.retry);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [client]);

  const retryPublication = useCallback(() => retry.current(), []);
  const navigateBuild = useCallback((href: string, preventDefault?: () => void) => {
    if (!pendingBuild.current || draftGuards.size || client.isMutating()) return false;
    const current = window.location;
    const target = new URL(href, current.href);
    if (target.origin !== current.origin || !isWorkspacePath(target.pathname) ||
        target.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, "")) return false;
    preventDefault?.();
    current.assign(target.href);
    return true;
  }, [client, draftGuards]);

  return <PublicationContext.Provider value={{ failed, retry: retryPublication, navigateBuild, draftGuards }}>
    {children}
  </PublicationContext.Provider>;
}

export function usePublicationFailure(updatedAt: number) {
  const status = useContext(PublicationContext);
  return status?.failed && updatedAt ? { updatedAt, retry: status.retry } : undefined;
}

export function useBuildNavigation() {
  return useContext(PublicationContext)?.navigateBuild;
}

/** Keep the normal navigation behavior while there is something to save. */
export function useBuildNavigationGuard(dirty: boolean) {
  const guards = useContext(PublicationContext)?.draftGuards;
  useLayoutEffect(() => {
    if (!dirty || !guards) return;
    const draft = Symbol();
    guards.add(draft);
    return () => { guards.delete(draft); };
  }, [dirty, guards]);
}
