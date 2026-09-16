"use client";
import { useQuery } from "@tanstack/react-query";
import type { UserProfile } from "@/lib/types";
import { api } from "./data";
export function useWorkspaceProfile() {
  return useQuery({
    queryKey: ["workspace-profile"],
    queryFn: () => api<UserProfile>("/profile"),
    staleTime: 300_000,
    retry: 0,
  });
}
export function accountName(profile: UserProfile | undefined, code: string) {
  return (
    profile?.accountLabels[code]?.trim() ||
    ({ A: "Invest", B: "Stocks ISA", C: "CFD" }[code] ?? code)
  );
}
