import { useQuery } from "@tanstack/react-query";
import type { components } from "@/lib/api-schema";
import { api } from "@/workspace/data";
import type { CSSProperties } from "react";
import { heat, heatMix } from "./sectors-data";

type HeatStyle = CSSProperties & Record<"--mx-world-heat-light" | "--mx-world-heat-dark" | "--mx-world-hue", string>;

export function globalHeatStyle(change: number | null | undefined): HeatStyle {
  const value = heat(change);
  return {
    "--mx-world-heat-light": heatMix(change, "light"),
    "--mx-world-heat-dark": heatMix(change, "dark"),
    "--mx-world-hue": value > 0 ? "var(--mx-up)" : value < 0 ? "var(--mx-down)" : "var(--mx-world-land)",
  };
}

export type GlobalMarketContribution = components["schemas"]["GlobalMarketContribution"];

export function useGlobalContribution(enabled: boolean) {
  return useQuery({
    queryKey: ["global-market-contribution"],
    queryFn: ({ signal }) => api<GlobalMarketContribution>("/indices/global-contribution", { signal }),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 60_000,
    retry: 0,
  });
}
