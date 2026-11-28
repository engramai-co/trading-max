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
    "--mx-world-hue": value > 0 ? "var(--heat-gain)" : value < 0 ? "var(--heat-loss)" : "var(--world-land)",
  };
}

export type GlobalMarketContribution = components["schemas"]["GlobalMarketContribution"];
export type GlobalMapMarket = components["schemas"]["GlobalMarketMove"]["market"];

export const CHINA_MAP_INDEX = { id: "csi-300", name: ["沪深 300", "CSI 300"] } as const;

export function globalMarketReading(
  market: GlobalMapMarket | "em" | "other", name: string, locale: "zh" | "en",
) {
  if (market !== "cn") return name;
  return `${name} · ${CHINA_MAP_INDEX.name[locale === "zh" ? 0 : 1]}`;
}

export const globalMarketContributionKey = ["global-market-contribution"] as const;

export function useGlobalContribution(enabled: boolean) {
  return useQuery({
    queryKey: globalMarketContributionKey,
    queryFn: ({ signal }) => api<GlobalMarketContribution>("/indices/global-contribution", { signal }),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 60_000,
    retry: 0,
  });
}
