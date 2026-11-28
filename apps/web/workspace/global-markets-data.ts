import { useQuery } from "@tanstack/react-query";
import type { components } from "@/lib/api-schema";
import { api } from "@/workspace/data";
import type { CSSProperties } from "react";
import { FLAT_BAND, heat, HEAT_MIX, HEAT_SATURATION } from "./sectors-data";

type HeatStyle = CSSProperties & Record<"--mx-world-heat-light" | "--mx-world-heat-dark" | "--mx-world-hue", string>;

export function globalHeatStyle(change: number | null | undefined): HeatStyle {
  const value = heat(change);
  const ratio = value === 0 ? 0 : Math.min(1, (Math.abs(change ?? 0) - FLAT_BAND) / (HEAT_SATURATION - FLAT_BAND));
  const mix = (minimum: number, maximum: number) =>
    value === 0 ? "0%" : Math.round(minimum + (maximum - minimum) * ratio) + "%";
  return {
    "--mx-world-heat-light": mix(17, HEAT_MIX.light),
    "--mx-world-heat-dark": mix(23, HEAT_MIX.dark),
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
