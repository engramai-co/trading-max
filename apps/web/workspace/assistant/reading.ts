"use client";

import type { components } from "@/lib/api-schema";
import { useQuery } from "@tanstack/react-query";
import type { Reading } from "./evidence";
import { useAssistant } from "./context";

export type ReadingRequest = { role: string; context: Record<string, unknown>; snapshotId?: string; cachedOnly?: boolean; latest?: boolean };
export async function fetchReading(request: ReadingRequest, signal: AbortSignal, onReading?: () => void, onLines?: (lines: Reading["lines"]) => void): Promise<Reading | null> {
  const { role, ...body } = request;
  const response = await fetch("/api/backend/assistant/roles/" + encodeURIComponent(role) + "/reading", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, cache: "no-store",
  });
  if (!response.ok) {
    const code = (await response.json().catch(() => null))?.detail?.code;
    const known = ["assistant_role_unknown", "assistant_context_invalid", "assistant_snapshot_missing",
      "assistant_busy", "assistant_disabled", "assistant_consent_required", "assistant_settings_changed", "assistant_unavailable",
      "request_too_large", "provider_not_configured", "provider_auth_failed", "provider_rate_limited"];
    throw new Error(known.includes(code) ? code : "assistant_unavailable");
  }
  if (!response.body) throw new Error("assistant_unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("assistant_interrupted");
      buffer += value;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const event: components["schemas"]["ReadingEvent"] = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event.type === "result" && event.reading) return event.reading;
        if (event.type === "empty") return null;
        if (event.type === "error") throw new Error(event.code ?? "assistant_unavailable");
        if (event.type === "reading") onReading?.();
        if (event.type === "lines" && event.lines) onLines?.(event.lines);
        end = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function useRoleReading(request: ReadingRequest, enabled: boolean, onLines?: (lines: Reading["lines"]) => void) {
  const assistant = useAssistant();
  return useQuery({
    queryKey: ["assistant-reading", request],
    queryFn: ({ signal }) => fetchReading(request, signal, undefined, onLines),
    enabled: assistant.ready && enabled, refetchInterval: request.latest && request.cachedOnly ? 30_000 : false,
    refetchIntervalInBackground: false, staleTime: request.latest ? 60_000 : Infinity, retry: false,
  });
}
