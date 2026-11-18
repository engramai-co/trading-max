"use client";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { UserProfile } from "@/lib/types";
import { api } from "@/workspace/data";
export const workspaceProfileKey = ["workspace-profile"] as const;
export const profileFreshFor = 300_000;
export const workspaceProfileQuery = queryOptions({
  queryKey: workspaceProfileKey,
  queryFn: ({signal}) => api<UserProfile>("/profile", {signal}),
});
export function useWorkspaceProfile() {
  return useQuery({...workspaceProfileQuery, staleTime: profileFreshFor, retry: 0});
}
export function accountName(profile: UserProfile | undefined, code: string) {
  const label =
    profile?.accountLabels[code]?.trim() ||
    ({ A: "Invest", B: "Stocks ISA", C: "CFD" }[code] ?? code);
  return label === "Stocks ISA" ? "Stocks\u00a0ISA" : label;
}
