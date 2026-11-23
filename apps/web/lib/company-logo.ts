/** Where a listing's logo can come from, most specific first. */

export const MAX_LOGO_BYTES = 512_000;
export const MAX_LOGO_REDIRECTS = 3;

export const ALLOWED_RASTER_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const LOGO_FALLBACK_HEADERS = {
  "Cache-Control": "private, max-age=3600",
  "X-Content-Type-Options": "nosniff",
} as const;

export const LOGO_ERROR_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function safeTicker(value: string) {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(ticker) && !ticker.includes("..") ? ticker : null;
}

export function safeIsin(value: string | null | undefined) {
  const isin = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : null;
}

export function safeDomain(value: string | null | undefined) {
  if (!value) return null;
  const domain = value.trim().toLowerCase();
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ? domain
    : null;
}

/**
 * An ISIN names one security, so it finds a fund's issuer mark where a short ticker can belong to another
 * company. The ticker follows, then the company's own site icon.
 */
export function logoCandidates(ticker: string, isin?: string | null, domain?: string | null) {
  return [
    ...(isin ? [`https://assets.parqet.com/logos/isin/${isin}?format=png`] : []),
    `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}?format=png`,
    ...(domain ? [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`] : []),
  ];
}

/** Accept only explicit raster image media types so upstream SVG never runs on the app origin. */
export function allowedLogoContentType(headerValue: string | null | undefined): string | null {
  const mediaType = headerValue?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_RASTER_TYPES.has(mediaType) ? mediaType : null;
}

/** Reject an advertised Content-Length that is malformed or exceeds the size bound. */
export function exceedsLogoSizeLimit(
  contentLengthHeader: string | null | undefined,
  maxBytes = MAX_LOGO_BYTES,
): boolean {
  if (contentLengthHeader == null) return false;
  const trimmed = contentLengthHeader.trim();
  if (!trimmed) return false;
  if (!/^\d+$/.test(trimmed)) return true;
  const bytes = Number(trimmed);
  return !Number.isSafeInteger(bytes) || bytes > maxBytes;
}

/** Restrict upstream requests and redirects to trusted HTTPS logo origins. */
export function isAllowedLogoUrl(candidate: string | URL): boolean {
  let url: URL;
  try {
    url = candidate instanceof URL ? candidate : new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return false;
  }
  if (url.hostname === "assets.parqet.com") return true;
  if (url.hostname === "www.google.com") return url.pathname === "/s2/favicons";
  return /^t\d+\.gstatic\.com$/.test(url.hostname);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const;
const FTYP_MAGIC = [0x66, 0x74, 0x79, 0x70] as const;
const AVIF_BRANDS = [
  [0x61, 0x76, 0x69, 0x66], // "avif"
  [0x61, 0x76, 0x69, 0x73], // "avis"
] as const;

function matchesBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function isAvifSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !matchesBytesAt(bytes, 4, FTYP_MAGIC)) return false;
  const boxSize =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (boxSize < 16 || boxSize % 4 !== 0 || boxSize > bytes.length) return false;
  const isAvifBrand = (offset: number) =>
    AVIF_BRANDS.some((brand) => matchesBytesAt(bytes, offset, brand));
  if (isAvifBrand(8)) return true;
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (isAvifBrand(offset)) return true;
  }
  return false;
}

/** Verify that response bytes begin with the magic signature for the declared raster type. */
export function matchesLogoSignature(
  bytes: Uint8Array,
  contentTypeHeader: string | null | undefined,
): boolean {
  switch (allowedLogoContentType(contentTypeHeader)) {
    case "image/png":
      return matchesBytesAt(bytes, 0, PNG_MAGIC);
    case "image/jpeg":
      return matchesBytesAt(bytes, 0, JPEG_MAGIC);
    case "image/webp":
      return matchesBytesAt(bytes, 0, RIFF_MAGIC) && matchesBytesAt(bytes, 8, WEBP_MAGIC);
    case "image/avif":
      return isAvifSignature(bytes);
    default:
      return false;
  }
}

/** Plain response headers for validated raster logo bytes. */
export function logoHeadersForUpstream(contentTypeHeader: string | null | undefined): Record<string, string> | null {
  const contentType = allowedLogoContentType(contentTypeHeader);
  if (!contentType) return null;
  return {
    "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}
