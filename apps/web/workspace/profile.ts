"use client";
import { useQuery } from "@tanstack/react-query";
import type { UserProfile } from "@/lib/types";
import { api } from "@/workspace/data";
export const workspaceProfileKey = ["workspace-profile"] as const;
export const profileFreshFor = 300_000;
export function useWorkspaceProfile() {
  return useQuery({
    queryKey: workspaceProfileKey,
    queryFn: ({signal}) => api<UserProfile>("/profile", {signal}),
    staleTime: profileFreshFor,
    retry: 0,
  });
}
export function accountName(profile: UserProfile | undefined, code: string) {
  const label =
    profile?.accountLabels[code]?.trim() ||
    ({ A: "Invest", B: "Stocks ISA", C: "CFD" }[code] ?? code);
  return label === "Stocks ISA" ? "Stocks\u00a0ISA" : label;
}
