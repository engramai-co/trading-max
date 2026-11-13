import { useQuery } from "@tanstack/react-query";
import type { components } from "@/lib/api-schema";
import { api } from "@/workspace/data";
import type { CSSProperties } from "react";
import { heat, HEAT_MIX } from "./sectors-data";

type HeatStyle = CSSProperties & Record<"--mx-world-heat-light" | "--mx-world-heat-dark" | "--mx-world-hue", string>;

export function globalHeatStyle(change: number | null | undefined): HeatStyle {
  const value = heat(change);
  const intensity = Math.abs(value);
  const wash = (minimum: number, maximum: number) =>
    intensity ? `${Math.round(minimum + (maximum - minimum) * intensity)}%` : "0%";
  return {
    "--mx-world-heat-light": wash(17, HEAT_MIX.light),
    "--mx-world-heat-dark": wash(23, HEAT_MIX.dark),
    "--mx-world-hue": value > 0 ? "var(--mx-up)" : value < 0 ? "var(--mx-down)" : "var(--mx-world-land)",
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
