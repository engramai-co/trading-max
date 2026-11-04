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
