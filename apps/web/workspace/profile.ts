"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { assistantSettingsChange } from "./assistant-settings";
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
export function useAssistantEnabled() {
  const client = useQueryClient();
  const profile = useWorkspaceProfile();
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === assistantSettingsChange)
        void client.invalidateQueries({queryKey: workspaceProfileKey, exact:true});
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [client]);
  return profile.data?.assistantEnabled === true;
}
export function accountName(profile: UserProfile | undefined, code: string) {
  const label =
    profile?.accountLabels[code]?.trim() ||
    ({ A: "Invest", B: "Stocks ISA", C: "CFD" }[code] ?? code);
  return label === "Stocks ISA" ? "Stocks\u00a0ISA" : label;
}
