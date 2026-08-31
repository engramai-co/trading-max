import "server-only";

import { QueryClient } from "@tanstack/react-query";

export function createServerQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
      },
    },
  });
}
