import { NextResponse } from "next/server";
import {
  exceedsLogoSizeLimit,
  isAllowedLogoUrl,
  LOGO_ERROR_HEADERS,
  LOGO_FALLBACK_HEADERS,
  logoCandidates,
  logoHeadersForUpstream,
  matchesLogoSignature,
  MAX_LOGO_BYTES,
  MAX_LOGO_REDIRECTS,
  safeDomain,
  safeIsin,
  safeTicker,
} from "@/lib/company-logo";

const LOGO_ACCEPT_HEADER = "image/avif,image/webp,image/png,image/jpeg";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UPSTREAM_TIMEOUT_MS = 4_000;

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_LOGO_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchLogo(initialUrl: string, requestSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  let currentUrl = initialUrl;

  try {
    for (let redirects = 0; redirects <= MAX_LOGO_REDIRECTS; redirects += 1) {
      if (!isAllowedLogoUrl(currentUrl)) return null;
      // Avoid Next.js's fetch cache cloning unbounded upstream bodies before validation,
      // and inspect redirects manually so targets cannot leave the trusted logo origins.
      const response = await fetch(currentUrl, {
        cache: "no-store",
        headers: {
          Accept: LOGO_ACCEPT_HEADER,
          "User-Agent": "Trading-Max-Logo-Cache/1.0",
        },
        redirect: "manual",
        signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || redirects === MAX_LOGO_REDIRECTS) return null;
        const target = new URL(location, currentUrl);
        if (!isAllowedLogoUrl(target)) return null;
        currentUrl = target.href;
        continue;
      }

      const headers = logoHeadersForUpstream(response.headers.get("content-type"));
      if (
        !response.ok
        || !headers
        || exceedsLogoSizeLimit(response.headers.get("content-length"))
      ) {
        await response.body?.cancel().catch(() => {});
        return null;
      }

      const bytes = await readBoundedBytes(response.body);
      if (!bytes || !matchesLogoSignature(bytes, headers["Content-Type"])) {
        return null;
      }
      return { bytes, headers };
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker: rawTicker } = await context.params;
  const ticker = safeTicker(rawTicker);
  if (!ticker) {
    return NextResponse.json(
      { detail: "invalid ticker" },
      { headers: LOGO_ERROR_HEADERS, status: 400 },
    );
  }
  const params = new URL(request.url).searchParams;
  const candidates = logoCandidates(ticker, safeIsin(params.get("isin")), safeDomain(params.get("domain")));
  for (const candidate of candidates) {
    if (request.signal?.aborted) break;
    const logo = await fetchLogo(candidate, request.signal);
    if (!logo) continue;
    return new Response(logo.bytes, { headers: logo.headers });
  }
  // No logo is a normal answer: the mark falls back to the ticker monogram
  // without a failed request in the console.
  return new Response(null, {
    headers: LOGO_FALLBACK_HEADERS,
    status: 204,
  });
}
