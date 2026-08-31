"use client";

import type { AnalysisLens, AnalysisRun } from "@/lib/types";

export type AnalysisRunState = {
  status: "idle" | "queued" | "running" | "failed";
  startedAt: number | null;
  error: string | null;
};

const IDLE: AnalysisRunState = {
  status: "idle",
  startedAt: null,
  error: null,
};

// Module-level state keeps an in-flight analysis alive when its panel
// unmounts, so switching tabs or tickers never cancels or hides the run.
const states = new Map<string, AnalysisRunState>();
const listeners = new Set<() => void>();
const refreshHandlers = new Set<() => void>();

export function analysisRunKey(lens: AnalysisLens, ticker?: string | null) {
  return `${lens}:${(ticker ?? "portfolio").toUpperCase()}`;
}

export function getAnalysisRunState(key: string): AnalysisRunState {
  return states.get(key) ?? IDLE;
}

export function getServerAnalysisRunState(): AnalysisRunState {
  return IDLE;
}

export function subscribeToAnalysisRuns(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerAnalysisRefresh(handler: () => void) {
  refreshHandlers.add(handler);
  return () => {
    refreshHandlers.delete(handler);
  };
}

function publish(key: string, next: AnalysisRunState) {
  if (next.status === "idle") {
    states.delete(key);
  } else {
    states.set(key, next);
  }
  for (const listener of listeners) listener();
}

export function isAnalysisRunActive(key: string) {
  const status = getAnalysisRunState(key).status;
  return status === "queued" || status === "running";
}

export async function startAnalysisRun({
  lens,
  ticker,
}: {
  lens: AnalysisLens;
  ticker?: string | null;
}) {
  const key = analysisRunKey(lens, ticker);
  if (isAnalysisRunActive(key)) return;
  const startedAt = Date.now();
  publish(key, { status: "queued", startedAt, error: null });

  try {
    const response = await fetch("/api/backend/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lenses: [lens],
        ticker: ticker ?? null,
        force: true,
      }),
    });
    if (!response.ok) {
      throw new Error(`submit failed: ${response.status}`);
    }
    const run = (await response.json()) as AnalysisRun;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      const statusResponse = await fetch(
        `/api/backend/analysis/${encodeURIComponent(run.runId)}`,
        { cache: "no-store" },
      );
      if (!statusResponse.ok) {
        throw new Error(`status failed: ${statusResponse.status}`);
      }
      const current = (await statusResponse.json()) as AnalysisRun;
      if (current.status === "succeeded" || current.status === "partial") {
        publish(key, IDLE);
        for (const handler of refreshHandlers) handler();
        return;
      }
      if (current.status === "failed" || current.status === "interrupted") {
        throw new Error(current.errors.join("; ") || current.status);
      }
      publish(key, { status: "running", startedAt, error: null });
    }
    throw new Error("analysis timed out");
  } catch (error) {
    publish(key, {
      status: "failed",
      startedAt: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
