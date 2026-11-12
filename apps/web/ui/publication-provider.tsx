"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { publicationFromHealth, watchPublications } from "@/lib/publication";
import { refreshPublicationQueries } from "@/lib/publication-queries";
import type { HealthDetails } from "@/lib/types";

type PublicationStatus = {
  failed: boolean;
  retry: () => void;
};
const PublicationContext = createContext<PublicationStatus | null>(null);

export function PublicationProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [failed, setFailed] = useState(false);
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    const watcher = watchPublications(async (signal) => {
      // Activity already reads the same health payload, often from a 5s poll.
      const existing = client.getQueryState<HealthDetails>(["workspace-health"]);
      if (existing?.status === "success" && existing.data?.health && Date.now() - existing.dataUpdatedAt < 15_000) {
        return publicationFromHealth(existing.data.health);
      }
      const response = await fetch("/api/backend/health", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Publication check failed");
      return publicationFromHealth(await response.json());
    }, (publication) => {
      setFailed(false);
      if (publication.runId) void refreshPublicationQueries(client, publication.runId);
    }, () => {
      setFailed(true);
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
  return <PublicationContext.Provider value={{ failed, retry: retryPublication }}>
    {children}
  </PublicationContext.Provider>;
}

export function usePublicationFailure(updatedAt: number) {
  const status = useContext(PublicationContext);
  return status?.failed && updatedAt ? { updatedAt, retry: status.retry } : undefined;
}
