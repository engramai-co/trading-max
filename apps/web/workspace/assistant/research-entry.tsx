"use client";

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ComponentProps } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { useWorkspaceProfile } from "../profile";
import { objects } from "../data";
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
  const key = eligible && initial?.ticker === ticker ? JSON.stringify([ticker,lens,snapshotId]) : "";
  const [placement, setPlacement] = useState({key:"",top:false});
  let top = placement.top;
  if (placement.key !== key) {
    const analyst = initial?.analyst ?? {};
    const expected = ["earningsEstimate","revenueEstimate","earningsEvents"].some(field => objects(analyst[field]).length);
    let expanded = false;
    try { expanded = localStorage.getItem("tm-reading-research-earnings") === "open"; } catch {}
    top = Boolean(key && (data?.reading || !expanded && expected && (enabled || profile.data?.assistantEnabled)));
    setPlacement({key,top});
  }
  const reserved = phone ? 144 : 72;
  const row = data?.reading ? <data.EarningsBrief ticker={ticker} lens={lens} reading={data.reading} minHeight={top ? reserved : undefined}/> : null;
  return {
    before: top && eligible && !assistant.suspended && (enabled || assistant.pending && profile.data?.assistantEnabled) ? row ?? <div aria-hidden="true" style={{minHeight:reserved}}/> : null,
    after: top ? null : row,
  };
}
