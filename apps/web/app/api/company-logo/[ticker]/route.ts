import { NextResponse } from "next/server";

const MAX_LOGO_BYTES = 512_000;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

function safeTicker(value: string) {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,24}$/.test(ticker) ? ticker : null;
}

function safeDomain(value: string | null) {
  if (!value) return null;
  const domain = value.trim().toLowerCase();
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ? domain
    : null;
}

async function fetchLogo(url: string) {
  try {
    const response = await fetch(url, {
      cache: "force-cache",
      headers: { "User-Agent": "Trading-Max-Logo-Cache/1.0" },
      next: { revalidate: 7 * 24 * 60 * 60 },
      signal: AbortSignal.timeout(4_000),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    const advertisedLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !response.ok
      || !ALLOWED_IMAGE_TYPES.has(contentType)
      || (advertisedLength > 0 && advertisedLength > MAX_LOGO_BYTES)
    ) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    return bytes.byteLength <= MAX_LOGO_BYTES ? { bytes, contentType } : null;
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
    return NextResponse.json({ detail: "invalid ticker" }, { status: 400 });
  }
  const domain = safeDomain(new URL(request.url).searchParams.get("domain"));
  const candidates = [
    `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}`,
    ...(domain
      ? [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`]
      : []),
  ];
  for (const candidate of candidates) {
    const logo = await fetchLogo(candidate);
    if (!logo) continue;
    return new Response(logo.bytes, {
      headers: {
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
        "Content-Type": logo.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new Response(null, {
    headers: { "Cache-Control": "private, max-age=3600" },
    status: 404,
  });
}
