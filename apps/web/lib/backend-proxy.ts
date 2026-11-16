import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";

export const PRIVATE_JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
} as const;

/**
 * Route handlers return plain bodies. Next.js (16.4.5 and later) drops a
 * handler's own Content-Encoding and compresses the response once itself, so
 * a pre-compressed body would reach the browser encoded twice.
 */
function privateHeaders(contentType: string) {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
  });
}

function withServerTiming(headers: Headers, durationMs?: number, upstream?: string | null) {
  if (upstream) headers.set("Server-Timing", upstream);
  if (durationMs !== undefined) {
    headers.append("Server-Timing", `backend_roundtrip;dur=${durationMs.toFixed(1)}`);
  }
  return headers;
}

export function backendUnavailable(detail = "Portfolio backend is not configured") {
  return Response.json({ detail }, { status: 503, headers: PRIVATE_JSON_HEADERS });
}

export function proxyBackendResponse(
  response: Response,
  contentType = "application/json",
  durationMs?: number,
) {
  return new Response(response.body, {
    status: response.status,
    headers: withServerTiming(
      privateHeaders(contentType),
      durationMs,
      response.headers.get("server-timing"),
    ),
  });
}

export function privateJsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: privateHeaders("application/json"),
  });
}

export async function proxyToBackend(
  pathname: string,
  init?: RequestInit,
  observe?: (response: Response) => void,
): Promise<Response> {
  if (!backendUrl()) return backendUnavailable();
  try {
    const startedAt = performance.now();
    const response = await backendFetch(pathname, init);
    observe?.(response);
    return proxyBackendResponse(
      response,
      "application/json",
      performance.now() - startedAt,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return Response.json({ detail: "Portfolio backend timed out" }, { status: 504, headers: PRIVATE_JSON_HEADERS });
    }
    return backendUnavailable(
      error instanceof Error ? error.message : "Portfolio backend is unavailable",
    );
  }
}

export async function proxyJsonRequest(
  pathname: string,
  request: Request,
  method: "POST" | "PUT" | "PATCH",
): Promise<Response> {
  return proxyToBackend(pathname, {
    method,
    body: await request.text(),
    headers: { "Content-Type": "application/json" },
  });
}

export async function proxyRawRequest(
  pathname: string,
  request: Request,
  method: "POST" | "PUT",
  headers: Record<string, string>,
  maxBytes = 1_000_000,
): Promise<Response> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return Response.json(
          {
            detail: {
              code: "request_too_large",
              message: `The upload exceeds the ${maxBytes.toLocaleString()} byte limit`,
            },
          },
          { status: 413, headers: PRIVATE_JSON_HEADERS },
        );
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return proxyToBackend(pathname, {
    method,
    body,
    headers,
  });
}
