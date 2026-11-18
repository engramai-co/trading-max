"use client";

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, type ComponentProps } from "react";
import { useAssistant } from "./context";
import type { PositionReading as Position } from "./research";

const LazyPosition = lazy(() => import("./research").then(module => ({default: module.PositionReading})));

export function PositionReading(props: ComponentProps<typeof Position>) {
  const { ready, open } = useAssistant();
  return ready && open && props.snapshotId
    ? <Suspense fallback={null}><LazyPosition {...props} /></Suspense> : null;
}

/** Commit the enabled lens and its cached headline in the same render. */
export function useEarningsBrief(ticker: string, lens: string, snapshotId: string | undefined, eligible: boolean) {
  const assistant = useAssistant();
  const enabled = Boolean(eligible && assistant.ready && snapshotId);
  const query = useQuery({
    queryKey: ["research-cached-earnings", ticker, snapshotId], enabled, retry: false, staleTime: 60_000,
    refetchInterval: enabled ? 30_000 : false, refetchIntervalInBackground: false,
    queryFn: async ({signal}) => {
      const { cachedEarnings, EarningsBrief } = await import("./research");
      const reading = await cachedEarnings(ticker, snapshotId!, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      return {reading, EarningsBrief};
    },
  });
  const data = enabled ? query.data : undefined;
  return {
    waiting: eligible && (assistant.pending || (enabled && query.isPending)),
    row: data?.reading ? <data.EarningsBrief ticker={ticker} lens={lens} reading={data.reading}/> : null,
  };
}
