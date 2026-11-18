import type { QueryClient } from "@tanstack/react-query";

/** Reconcile the observed pointer against what each active reader actually fetched. */
export function refreshPublicationQueries(client: QueryClient, runId: string) {
  const onboarding = client.getQueryCache().find({ queryKey: ["local-onboarding"], exact: true });
  const confirming = onboarding?.isActive() && !(onboarding.state.data as { confirmed?: boolean } | undefined)?.confirmed;

  return client.invalidateQueries({
    type: "active",
    predicate(query) {
      if (query.state.fetchStatus !== "idle") return false;
      const [kind, group, view] = query.queryKey;
      const { status, data } = query.state;
      if (kind === "portfolio-history") {
        // New history keys come from the lens. Revisit only a failed current key.
        return status === "error" && (group as { runId?: string })?.runId === runId;
      }
      const snapshot = data as { runId?: string; status?: { runId?: string } } | undefined;
      if (kind === "dashboard-lens" && group === "latest") {
        if (view === "overview" && confirming) return false;
        return status === "error" || snapshot?.runId !== runId;
      }
      if (kind === "workspace-research-shell") {
        return status === "error" || snapshot?.status?.runId !== runId;
      }
      // These lenses also include snapshot-dependent holdings or records.
      if (kind === "workspace-research") {
        return status === "error" || (view === "overview" || view === "ledger") && snapshot?.runId !== runId;
      }
      if (kind === "workspace-prices") return status === "error";
      // Notices compare saved valuation versions with the latest publication. Switched off,
      // they read nothing, so a new publication has nothing to refresh.
      if (kind === "evidence-notices") {
        const notices = data as { enabled?: boolean; runId?: string | null } | undefined;
        return status === "error" || (notices?.enabled === true && notices.runId !== runId);
      }
      return false;
    },
  }, { cancelRefetch: false });
}
