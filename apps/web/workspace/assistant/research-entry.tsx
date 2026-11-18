"use client";

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, type ComponentProps } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { useWorkspaceProfile } from "../profile";
import type { ResearchLensSnapshot } from "@/lib/types";
import { useAssistant } from "./context";
import type { PositionReading as Position } from "./research";

const LazyPosition = lazy(() => import("./research").then(module => ({default: module.PositionReading})));

export function PositionReading(props: ComponentProps<typeof Position>) {
  const { ready, open } = useAssistant();
  return ready && open && props.snapshotId
    ? <Suspense fallback={null}><LazyPosition {...props} /></Suspense> : null;
}

/** The first deterministic render decides where a later publication can appear. */
export function useEarningsBrief(ticker: string, lens: string, snapshotId: string | undefined, eligible: boolean, initial?: ResearchLensSnapshot) {
  const assistant = useAssistant();
  const profile = useWorkspaceProfile();
  const phone = useMediaQuery("(max-width: 767px)");
  const enabled = Boolean(eligible && assistant.ready && snapshotId);
  const query = useQuery({
    queryKey: ["assistant-reading", "research-cached-earnings", ticker, snapshotId], enabled, retry: false, staleTime: 60_000,
    refetchInterval: enabled ? 30_000 : false, refetchIntervalInBackground: false,
    queryFn: async ({signal}) => {
      const { cachedEarnings, EarningsBrief } = await import("./research");
      const reading = await cachedEarnings(ticker, snapshotId!, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      return {reading, EarningsBrief};
    },
  });
  const data = enabled ? query.data : undefined;
  const reserved = phone ? 144 : 72;
  if (data?.reading) return <data.EarningsBrief ticker={ticker} lens={lens} reading={data.reading} minHeight={reserved}/>;
  const reserve = eligible && initial?.ticker === ticker && initial.earningsBriefEligible &&
    !assistant.suspended && (enabled || assistant.pending && profile.data?.assistantEnabled);
  return reserve ? <div aria-hidden="true" style={{minHeight:reserved}}/> : null;
}
