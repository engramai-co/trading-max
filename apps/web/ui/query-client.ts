import { useSyncExternalStore } from "react";
import { QueryClient, defaultShouldDehydrateQuery } from "@tanstack/react-query";

/** The workspace's query client; tests use the same configuration. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
      mutations: {
        retry: 0,
      },
      queries: {
        gcTime: 30 * 60_000,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
    },
  });
}


function subscribeBrowserConnection(update: () => void) {
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  return () => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  };
}

/** Paused queries report their own state. The connection also applies to views with cached data. */
export function useBrowserOnline() {
  return useSyncExternalStore(subscribeBrowserConnection, () => navigator.onLine, () => true);
}
