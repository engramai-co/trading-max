import "server-only";

import { Readable, pipeline } from "node:stream";
import { constants, createBrotliCompress } from "node:zlib";

import { backendFetch, backendUrl } from "@/lib/backend";

export const PRIVATE_JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
} as const;

const COMPRESSION_MINIMUM_BYTES = 1_024;

type ContentCoding = "br" | "gzip";

function preferredCoding(value?: string | null): ContentCoding | null {
  if (!value) return null;
  const weights = new Map<string, number>();
  for (const item of value.split(",")) {
    const [coding, ...parameters] = item.trim().toLowerCase().split(";").map((part) => part.trim());
    const q = parameters.find((part) => part.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(coding, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  const quality = (coding: ContentCoding) => weights.get(coding) ?? weights.get("*") ?? 0;
  const br = quality("br"), gzip = quality("gzip");
  if (br > 0 && br >= gzip) return "br";
  return gzip > 0 ? "gzip" : null;
}

function compressedBody(
  body: ReadableStream<Uint8Array> | null,
  acceptEncoding?: string | null,
  contentLength?: number,
) {
  const largeEnough = contentLength == null || contentLength >= COMPRESSION_MINIMUM_BYTES;
  const coding = preferredCoding(acceptEncoding);
  if (!body || !largeEnough || !coding) return null;
  if (coding === "gzip") {
    return { coding, body: (body as ReadableStream<BufferSource>).pipeThrough(new CompressionStream("gzip")) };
  }
  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const compressor = createBrotliCompress({ params: {
    [constants.BROTLI_PARAM_QUALITY]: 4,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  } });
  const compressed = Readable.toWeb(compressor) as ReadableStream<Uint8Array>;
  // Pipeline propagates client cancellation and upstream failures to both streams.
  pipeline(source, compressor, () => undefined);
  return { coding, body: compressed };
}

function privateHeaders(contentType: string, coding?: ContentCoding) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
    "Vary": "Accept-Encoding",
  });
  if (coding) headers.set("Content-Encoding", coding);
  return headers;
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
  acceptEncoding?: string | null,
  durationMs?: number,
) {
  const lengthHeader = response.headers.get("content-length");
  const rawLength = lengthHeader == null ? Number.NaN : Number(lengthHeader);
  const contentLength = Number.isFinite(rawLength) ? rawLength : undefined;
  const compressed = compressedBody(response.body, acceptEncoding, contentLength);
  return new Response(compressed?.body ?? response.body, {
    status: response.status,
    headers: withServerTiming(
      privateHeaders(contentType, compressed?.coding),
      durationMs,
      response.headers.get("server-timing"),
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
  return new Response(compressed?.body ?? body, {
    ...init,
    headers: privateHeaders("application/json", compressed?.coding),
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
