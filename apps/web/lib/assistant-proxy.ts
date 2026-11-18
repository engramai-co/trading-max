import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";
import { backendUnavailable, PRIVATE_JSON_HEADERS } from "@/lib/backend-proxy";

export const ASSISTANT_MAX_REQUEST_BYTES = 1_000_000;
const FORWARDED_QUERY = ["page", "tz"] as const;
// The AI SDK client reads the stream protocol version from this header.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-vercel-ai-ui-message-stream"] as const;

async function boundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Pass the assistant's event stream through untouched: no buffering, no
 * compression. Closing the browser request aborts the backend run.
 */
export async function proxyAssistantChat(request: Request, path = "/v1/assistant/chat"): Promise<Response> {
  if (!backendUrl()) return backendUnavailable();
  const body = await boundedBody(request, ASSISTANT_MAX_REQUEST_BYTES);
  if (body === null) {
    return Response.json(
      { detail: { code: "request_too_large" } },
      { status: 413, headers: PRIVATE_JSON_HEADERS },
    );
  }
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  for (const key of FORWARDED_QUERY) {
    const value = incoming.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const suffix = query.size ? `?${query}` : "";
  let upstream: Response;
  try {
    upstream = await backendFetch(path + suffix, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return backendUnavailable("Portfolio backend is unavailable");
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
