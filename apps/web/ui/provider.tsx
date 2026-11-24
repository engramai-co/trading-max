"use client";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import {
  ColorSchemeProvider,
  createMantineColorSchemeManager,
} from "@/components/color-scheme-provider";
import { DEFAULT_COLOR_SCHEME } from "@/lib/color-scheme";
import { tradingMaxTheme } from "@/ui/theme";
import { PublicationProvider } from "@/ui/publication-provider";
import { FinePointerProvider } from "@/ui/pointer";
import type { SnapshotCacheEntry } from "@/lib/snapshot-cache";
import { SnapshotCacheProvider } from "@/ui/snapshot-cache-provider";
import { createQueryClient } from "@/ui/query-client";

export function TradingMaxProvider({
  children, scope, desktopCache,
}: Readonly<{ children: React.ReactNode; scope: string; desktopCache: { entries: SnapshotCacheEntry[] } | null }>) {
  const [queryClient] = useState(createQueryClient);
  const [colorSchemeManager] = useState(() => createMantineColorSchemeManager(DEFAULT_COLOR_SCHEME));

  return (
    <ColorSchemeProvider defaultColorScheme={DEFAULT_COLOR_SCHEME}>
      <MantineProvider
        defaultColorScheme={DEFAULT_COLOR_SCHEME}
        colorSchemeManager={colorSchemeManager}
        theme={tradingMaxTheme}
      >
        <QueryClientProvider client={queryClient}>
          <Notifications position="top-right" />
          <SnapshotCacheProvider scope={scope} desktop={desktopCache}>
            <PublicationProvider><FinePointerProvider>{children}</FinePointerProvider></PublicationProvider>
          </SnapshotCacheProvider>
        </QueryClientProvider>
      </MantineProvider>
    </ColorSchemeProvider>
  );
}
