"use client";

import { Skeleton } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { AnalysisPanel } from "@/components/analysis-panel";
import { LensError } from "@/components/lens-state";
import type { AnalysisArtifact, AnalysisLens, LocalizedAnalysisText } from "@/lib/types";

export function AnalysisLensPanel({
  lens,
  ticker,
  compact = false,
  scope,
}: {
  lens: AnalysisLens;
  ticker?: string;
  compact?: boolean;
  scope?: LocalizedAnalysisText;
}) {
  const analysis = useQuery({
    queryFn: async () => {
      const query = new URLSearchParams({ lens });
      if (ticker) query.set("ticker", ticker);
      const response = await fetch(`/api/backend/analysis?${query}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`analysis returned ${response.status}`);
      return (await response.json()) as AnalysisArtifact;
    },
    queryKey: ["latest-analysis", lens, ticker ?? null],
    retry: 1,
    staleTime: 30_000,
  });

  if (analysis.isPending) return <Skeleton h={68} radius="lg" />;
  if (analysis.isError) return <LensError retry={() => void analysis.refetch()} />;
  return (
    <AnalysisPanel
      analysis={analysis.data ?? null}
      compact={compact}
      onAnalysisComplete={() => void analysis.refetch()}
      lens={lens}
      scope={scope}
      ticker={ticker}
    />
  );
}
