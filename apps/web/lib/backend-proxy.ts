import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";

export const PRIVATE_JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
} as const;

const COMPRESSION_MINIMUM_BYTES = 1_024;

function acceptsGzip(value?: string | null) {
  return value?.split(",").some((item) => {
    const [coding, ...parameters] = item.trim().split(";").map((part) => part.trim());
    const quality = parameters.find((parameter) => parameter.toLowerCase().startsWith("q="));
    return coding.toLowerCase() === "gzip" && Number(quality?.slice(2) ?? 1) > 0;
  }) ?? false;
}

function compressedBody(
  body: ReadableStream<Uint8Array> | null,
  acceptEncoding?: string | null,
  contentLength?: number,
) {
  const largeEnough = contentLength == null || contentLength >= COMPRESSION_MINIMUM_BYTES;
  return body && acceptsGzip(acceptEncoding) && largeEnough
    ? (body as ReadableStream<BufferSource>).pipeThrough(new CompressionStream("gzip"))
    : null;
}

function privateHeaders(contentType: string, compressed: boolean) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
  });
  if (compressed) {
    headers.set("Content-Encoding", "gzip");
    headers.set("Vary", "Accept-Encoding");
  }
  return headers;
}

function withServerTiming(headers: Headers, durationMs?: number) {
  if (durationMs !== undefined) {
    headers.set("Server-Timing", `backend_roundtrip;dur=${durationMs.toFixed(1)}`);
  }
  return headers;
}

export function backendUnavailable(detail = "Portfolio backend is not configured") {
  return Response.json({ detail }, { status: 503, headers: PRIVATE_JSON_HEADERS });
}

export function proxyBackendResponse(
  response: Response,
  contentType = "application/json",
  acceptEncoding?: string | null,
  durationMs?: number,
) {
  const lengthHeader = response.headers.get("content-length");
  const rawLength = lengthHeader == null ? Number.NaN : Number(lengthHeader);
  const contentLength = Number.isFinite(rawLength) ? rawLength : undefined;
  const compressed = compressedBody(response.body, acceptEncoding, contentLength);
  return new Response(compressed ?? response.body, {
    status: response.status,
    headers: withServerTiming(
      privateHeaders(contentType, compressed !== null),
      durationMs,
    ),
  });
}

export function privateJsonResponse(
  request: Request,
  payload: unknown,
  init: ResponseInit = {},
) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = new Blob([bytes]).stream();
  const compressed = compressedBody(
    body,
    request.headers.get("accept-encoding"),
    bytes.byteLength,
  );
  return new Response(compressed ?? body, {
    ...init,
    headers: privateHeaders("application/json", compressed !== null),
  });
}

export async function proxyToBackend(
  pathname: string,
  init?: RequestInit,
  acceptEncoding?: string | null,
): Promise<Response> {
  if (!backendUrl()) return backendUnavailable();
  try {
    const startedAt = performance.now();
    const response = await backendFetch(pathname, init);
    return proxyBackendResponse(
      response,
      "application/json",
      acceptEncoding,
      performance.now() - startedAt,
    );
  } catch (error) {
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
