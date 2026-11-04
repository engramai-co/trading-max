"use client";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { tradingMaxTheme } from "@/ui/theme";
import { FinePointerProvider } from "@/ui/pointer";
import { createQueryClient } from "@/ui/query-client";

export function TradingMaxProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(createQueryClient);

  return (
    <MantineProvider
      defaultColorScheme="auto"
      theme={tradingMaxTheme}
    >
      <QueryClientProvider client={queryClient}>
        <Notifications position="top-right" />
        <FinePointerProvider>{children}</FinePointerProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
