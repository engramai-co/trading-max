import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";

export const PRIVATE_JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
} as const;

export const JSON_MEDIA_TYPES = ["application/json"] as const;

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function parseHttpOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const prefix = `${parsed.protocol}//`;
    if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" || /[/?#\\]/.test(trimmed.slice(prefix.length))) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function firstHeaderToken(value: string): string | null {
  const first = value.split(",", 1)[0]?.trim();
  return first || null;
}

function supervisedLoopbackOrigin(): string | null {
  if (
    process.env.HOSTNAME === "127.0.0.1"
    && process.env.TRADING_MAX_DESKTOP_SUPERVISOR_PID
    && process.env.PORT
  ) {
    return parseHttpOrigin(`http://127.0.0.1:${process.env.PORT}`);
  }
  return null;
}

function requestHostOrigin(request: Request, proto: string): string | null {
  const rawHost = request.headers.get("host");
  if (rawHost !== null) {
    const trimmed = rawHost.trim();
    return trimmed ? parseHttpOrigin(`${proto}://${trimmed}`) : null;
  }
  try {
    const url = new URL(request.url);
    return parseHttpOrigin(`${proto}://${url.host}`);
  } catch {
    return null;
  }
}

function expectedRequestOrigin(request: Request): string | null {
  const supervised = supervisedLoopbackOrigin();
  if (supervised) {
    const hostOrigin = requestHostOrigin(request, "http");
    return hostOrigin === supervised ? supervised : null;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return null;
  }

  const rawForwardedProto = request.headers.get("x-forwarded-proto");
  const proto = rawForwardedProto !== null
    ? firstHeaderToken(rawForwardedProto)?.toLowerCase() ?? null
    : requestUrl.protocol.slice(0, -1).toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  const rawForwardedHost = request.headers.get("x-forwarded-host");
  if (rawForwardedHost !== null) {
    const forwardedHost = firstHeaderToken(rawForwardedHost);
    return forwardedHost ? parseHttpOrigin(`${proto}://${forwardedHost}`) : null;
  }

  return requestHostOrigin(request, proto);
}

function requestMediaType(request: Request): string | null {
  const raw = request.headers.get("content-type");
  if (raw === null) return null;

  let inQuotes = false;
  let escaped = false;
  let quoteJustClosed = false;
  let prevNonSpace = "";
  let semicolonIndex = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
        quoteJustClosed = true;
      }
      continue;
    }
    if (ch === " " || ch === "\t") continue;
    if (quoteJustClosed) {
      if (ch !== ";") return null;
      quoteJustClosed = false;
      prevNonSpace = ";";
      continue;
    }
    if (ch === '"') {
      if (semicolonIndex === -1 || prevNonSpace !== "=") return null;
      inQuotes = true;
      continue;
    }
    if (ch === ",") return null;
    if (ch === ";" && semicolonIndex === -1) semicolonIndex = i;
    prevNonSpace = ch;
  }

  if (inQuotes || escaped) return null;

  const mediaType = (semicolonIndex === -1 ? raw : raw.slice(0, semicolonIndex))
    .trim()
    .toLowerCase();
  return mediaType || null;
}

export function validateWriteRequest(
  request: Request,
  options?: { allowedMediaTypes?: readonly string[] },
): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return Response.json(
      {
        detail: {
          code: "fetch_metadata_rejected",
          message: "Cross-site write requests are not allowed",
        },
      },
      { status: 403, headers: PRIVATE_JSON_HEADERS },
    );
  }

  const supervised = supervisedLoopbackOrigin();
  if (supervised && expectedRequestOrigin(request) === null) {
    return Response.json(
      {
        detail: {
          code: "origin_not_allowed",
          message: "Request host is not allowed",
        },
      },
      { status: 403, headers: PRIVATE_JSON_HEADERS },
    );
  }

  // Trust browser-enforced Sec-Fetch-Site when present; reverse proxies such
  // as Tailscale Serve can rewrite Host without verified forwarded headers.
  const rawOrigin = fetchSite === null ? request.headers.get("origin") : null;
  if (rawOrigin !== null) {
    const origin = parseHttpOrigin(rawOrigin);
    const expected = expectedRequestOrigin(request);
    if (!origin || !expected || origin !== expected) {
      return Response.json(
        {
          detail: {
            code: "origin_not_allowed",
            message: "Cross-site write requests are not allowed",
          },
        },
        { status: 403, headers: PRIVATE_JSON_HEADERS },
      );
    }
  }

  const allowedMediaTypes = options?.allowedMediaTypes;
  if (allowedMediaTypes?.length) {
    const mediaType = requestMediaType(request);
    if (!mediaType || !allowedMediaTypes.includes(mediaType)) {
      return Response.json(
        {
          detail: {
            code: "unsupported_media_type",
            message: allowedMediaTypes.length === 1 && allowedMediaTypes[0] === "application/json"
              ? "Write requests must use application/json"
              : `Unsupported Content-Type; expected ${allowedMediaTypes.join(", ")}`,
          },
        },
        { status: 415, headers: PRIVATE_JSON_HEADERS },
      );
    }
  }

  return null;
}

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
  const rejected = validateWriteRequest(request, { allowedMediaTypes: JSON_MEDIA_TYPES });
  if (rejected) return rejected;
  return proxyToBackend(pathname, {
    method,
    body: await request.text(),
    headers: { "Content-Type": "application/json" },
  });
}

export async function proxyDeleteRequest(
  pathname: string,
  request: Request,
): Promise<Response> {
  const rejected = validateWriteRequest(request);
  if (rejected) return rejected;
  return proxyToBackend(pathname, { method: "DELETE" });
}

export async function proxyRawRequest(
  pathname: string,
  request: Request,
  method: "POST" | "PUT",
  headers: Record<string, string>,
  maxBytes = 1_000_000,
  allowedMediaTypes?: readonly string[],
): Promise<Response> {
  const rejected = validateWriteRequest(request, { allowedMediaTypes });
  if (rejected) return rejected;
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
