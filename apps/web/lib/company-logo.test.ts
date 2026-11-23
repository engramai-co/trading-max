import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/company-logo/[ticker]/route";
import {
  allowedLogoContentType,
  exceedsLogoSizeLimit,
  isAllowedLogoUrl,
  LOGO_ERROR_HEADERS,
  LOGO_FALLBACK_HEADERS,
  logoCandidates,
  logoHeadersForUpstream,
  matchesLogoSignature,
  MAX_LOGO_BYTES,
  safeIsin,
  safeTicker,
} from "./company-logo";

const PNG_SAMPLE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_SAMPLE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_SAMPLE = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const AVIF_SAMPLE = new Uint8Array([
  0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const getLogo = (pathAndQuery: string, ticker: string) =>
  GET(new Request(`http://localhost/api/company-logo/${pathAndQuery}`), {
    params: Promise.resolve({ ticker }),
  });

describe("company logo sources", () => {
  it("tries a valid ISIN before the ticker and the site icon using raster PNG candidates", () => {
    expect(logoCandidates("SEMI", safeIsin("ie000i8krll9"), "example.com")).toEqual([
      "https://assets.parqet.com/logos/isin/IE000I8KRLL9?format=png",
      "https://assets.parqet.com/logos/symbol/SEMI?format=png",
      "https://www.google.com/s2/favicons?domain=example.com&sz=128",
    ]);
  });

  it("ignores a malformed ISIN and rejects path-traversal tickers", () => {
    expect(safeIsin("IE000I8KRLL")).toBeNull();
    expect(safeIsin("../etc/passwd")).toBeNull();
    expect(safeTicker("..")).toBeNull();
    expect(safeTicker(".")).toBeNull();
    expect(safeTicker("A..B")).toBeNull();
    expect(safeTicker("BRK.B")).toBe("BRK.B");
    expect(logoCandidates("AAPL", safeIsin("not-an-isin"))).toEqual([
      "https://assets.parqet.com/logos/symbol/AAPL?format=png",
    ]);
  });
});

describe("company logo content-type, header, size, and URL policies", () => {
  it("allows only explicit raster image media types and rejects SVG and documents", () => {
    expect(allowedLogoContentType("image/png")).toBe("image/png");
    expect(allowedLogoContentType("Image/WebP; charset=binary")).toBe("image/webp");
    expect(allowedLogoContentType(" image/jpeg ")).toBe("image/jpeg");
    expect(allowedLogoContentType("image/avif")).toBe("image/avif");
    expect(allowedLogoContentType("image/svg+xml")).toBeNull();
    expect(allowedLogoContentType("image/svg+xml; charset=utf-8")).toBeNull();
    expect(allowedLogoContentType("text/html; charset=utf-8")).toBeNull();
    expect(allowedLogoContentType("application/octet-stream")).toBeNull();
    expect(allowedLogoContentType(null)).toBeNull();
  });

  it("builds plain nosniff headers only for allowed raster types", () => {
    expect(logoHeadersForUpstream("Image/PNG; charset=binary")).toEqual({
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    });
    expect(logoHeadersForUpstream("image/svg+xml")).toBeNull();
    expect(LOGO_FALLBACK_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(LOGO_ERROR_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("validates advertised Content-Length bounds", () => {
    expect(exceedsLogoSizeLimit(null)).toBe(false);
    expect(exceedsLogoSizeLimit(String(MAX_LOGO_BYTES))).toBe(false);
    expect(exceedsLogoSizeLimit(String(MAX_LOGO_BYTES + 1))).toBe(true);
    expect(exceedsLogoSizeLimit("-1")).toBe(true);
    expect(exceedsLogoSizeLimit("abc")).toBe(true);
  });

  it("allows only trusted HTTPS logo origins and Google favicon redirect hosts", () => {
    expect(isAllowedLogoUrl("https://assets.parqet.com/logos/symbol/AAPL?format=png")).toBe(true);
    expect(isAllowedLogoUrl("https://www.google.com/s2/favicons?domain=example.com&sz=128")).toBe(true);
    expect(isAllowedLogoUrl("https://t3.gstatic.com/faviconV2?url=http://example.com&size=128")).toBe(true);
    expect(isAllowedLogoUrl("http://assets.parqet.com/logos/symbol/AAPL?format=png")).toBe(false);
    expect(isAllowedLogoUrl("https://www.google.com/sorry/index")).toBe(false);
    expect(isAllowedLogoUrl("https://127.0.0.1/logo.png")).toBe(false);
    expect(isAllowedLogoUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedLogoUrl("https://evil.example/logo.png")).toBe(false);
    expect(isAllowedLogoUrl("https://user:pass@assets.parqet.com/logos/symbol/AAPL")).toBe(false);
    expect(isAllowedLogoUrl("https://assets.parqet.com:8443/logos/symbol/AAPL")).toBe(false);
  });

  it("matches PNG, JPEG, WebP, and AVIF magic signatures and rejects mislabelled or truncated bytes", () => {
    expect(matchesLogoSignature(PNG_SAMPLE, "image/png")).toBe(true);
    expect(matchesLogoSignature(PNG_SAMPLE, "Image/PNG; charset=binary")).toBe(true);
    expect(matchesLogoSignature(PNG_SAMPLE.slice(0, 4), "image/png")).toBe(false);

    expect(matchesLogoSignature(JPEG_SAMPLE, "image/jpeg")).toBe(true);
    expect(matchesLogoSignature(JPEG_SAMPLE.slice(0, 2), "image/jpeg")).toBe(false);

    expect(matchesLogoSignature(WEBP_SAMPLE, "image/webp")).toBe(true);
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(matchesLogoSignature(riffWave, "image/webp")).toBe(false);

    expect(matchesLogoSignature(AVIF_SAMPLE, "image/avif")).toBe(true);
    const avisBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(matchesLogoSignature(avisBytes, "image/avif")).toBe(true);
    const avifCompatibleBrand = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
      0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x61, 0x66,
    ]);
    expect(matchesLogoSignature(avifCompatibleBrand, "image/avif")).toBe(true);
    const heicBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(matchesLogoSignature(heicBytes, "image/avif")).toBe(false);
    const truncatedAvif = new Uint8Array(AVIF_SAMPLE);
    truncatedAvif[3] = 0x20;
    expect(matchesLogoSignature(truncatedAvif, "image/avif")).toBe(false);
    const badSizeAvif = new Uint8Array(AVIF_SAMPLE);
    badSizeAvif[3] = 0x08;
    expect(matchesLogoSignature(badSizeAvif, "image/avif")).toBe(false);
    // A 17-byte ftyp box ends with a partial compatible brand, so it is not a valid box.
    const partialBrandAvif = new Uint8Array([
      0x00, 0x00, 0x00, 0x11, 0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
      0x61, 0x00, 0x00, 0x00,
    ]);
    expect(matchesLogoSignature(partialBrandAvif, "image/avif")).toBe(false);
    const brandPastFtyp = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
      0x61, 0x76, 0x69, 0x66,
    ]);
    expect(matchesLogoSignature(brandPastFtyp, "image/avif")).toBe(false);

    const htmlBytes = new TextEncoder().encode("<!doctype html><html><body>error</body></html>");
    expect(matchesLogoSignature(htmlBytes, "image/png")).toBe(false);
    expect(matchesLogoSignature(htmlBytes, "image/jpeg")).toBe(false);
    expect(matchesLogoSignature(htmlBytes, "image/webp")).toBe(false);
    expect(matchesLogoSignature(htmlBytes, "image/avif")).toBe(false);
    expect(matchesLogoSignature(JPEG_SAMPLE, "image/png")).toBe(false);
    expect(matchesLogoSignature(PNG_SAMPLE, "image/svg+xml")).toBe(false);
    expect(matchesLogoSignature(new Uint8Array(0), "image/png")).toBe(false);
  });
});

describe("company logo route", () => {
  it("sets nosniff on 400 invalid ticker responses without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("..", "..");
    expect(response.status).toBe(400);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns plain bounded raster bytes with nosniff and manual redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG_SAMPLE, {
        headers: {
          "Content-Encoding": "gzip",
          "Content-Type": "image/png; charset=binary",
        },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("AAPL", "AAPL");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_SAMPLE);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://assets.parqet.com/logos/symbol/AAPL?format=png",
      expect.objectContaining({
        cache: "no-store",
        redirect: "manual",
      }),
    );
  });

  it("rejects upstream SVG and falls back to 204 ticker monogram with nosniff", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", {
        headers: { "Content-Type": "image/svg+xml" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("AAPL", "AAPL");
    expect(response.status).toBe(204);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.body).toBeNull();
  });

  it.each([
    { contentLength: null, label: "absent Content-Length" },
    { contentLength: "100", label: "understated Content-Length" },
  ])(
    "stream-limits responses with $label and cancels early",
    async ({ contentLength }) => {
      const cancelMock = vi.fn();
      let pulls = 0;
      const oversizedStream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls <= 5) {
              controller.enqueue(new Uint8Array(300_000));
            } else {
              controller.close();
            }
          },
          cancel: cancelMock,
        },
        { highWaterMark: 0 },
      );
      const headers: Record<string, string> = { "Content-Type": "image/png" };
      if (contentLength !== null) {
        headers["Content-Length"] = contentLength;
      }
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(oversizedStream, {
          headers,
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await getLogo("AAPL", "AAPL");
      expect(response.status).toBe(204);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(cancelMock).toHaveBeenCalledOnce();
      expect(pulls).toBe(2);
    },
  );

  it("cancels responses whose advertised Content-Length exceeds the bound without pulling chunks", async () => {
    const cancelMock = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(10));
        },
        cancel: cancelMock,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: {
            "Content-Length": String(MAX_LOGO_BYTES + 1),
            "Content-Type": "image/png",
          },
          status: 200,
        }),
      ),
    );

    const response = await getLogo("AAPL", "AAPL");
    expect(response.status).toBe(204);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(pulls).toBe(0);
  });

  it("allows an exact-bound raster payload and rejects an empty 200 body", async () => {
    const exactBytes = new Uint8Array(MAX_LOGO_BYTES);
    exactBytes.set(WEBP_SAMPLE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(exactBytes, {
          headers: { "Content-Type": "image/webp" },
          status: 200,
        }),
      ),
    );
    const okResponse = await getLogo("AAPL", "AAPL");
    expect(okResponse.status).toBe(200);
    expect(okResponse.headers.get("content-type")).toBe("image/webp");
    expect((await okResponse.arrayBuffer()).byteLength).toBe(MAX_LOGO_BYTES);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(0), {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      ),
    );
    const emptyResponse = await getLogo("AAPL", "AAPL");
    expect(emptyResponse.status).toBe(204);
    expect(emptyResponse.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("follows validated redirects to trusted gstatic hosts and rejects untrusted redirect targets", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://assets.parqet.com/")) {
        return new Response(null, {
          headers: { Location: "https://evil.example/payload.png" },
          status: 302,
        });
      }
      if (url.startsWith("https://www.google.com/s2/favicons")) {
        return new Response(null, {
          headers: { Location: "https://t3.gstatic.com/faviconV2?url=http://example.com&size=128" },
          status: 301,
        });
      }
      if (url.startsWith("https://t3.gstatic.com/faviconV2")) {
        return new Response(PNG_SAMPLE, {
          headers: { "Content-Type": "image/png" },
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("AAPL?domain=example.com", "AAPL");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_SAMPLE);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://assets.parqet.com/logos/symbol/AAPL?format=png",
      "https://www.google.com/s2/favicons?domain=example.com&sz=128",
      "https://t3.gstatic.com/faviconV2?url=http://example.com&size=128",
    ]);
  });

  it("rejects mislabelled markup or mismatched raster bodies and moves on to the next candidate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><body>Not a PNG</body></html>", {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JPEG_SAMPLE, {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(AVIF_SAMPLE, {
          headers: { "Content-Type": "image/avif" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("SEMI?isin=IE000I8KRLL9&domain=example.com", "SEMI");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/avif");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(AVIF_SAMPLE);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://assets.parqet.com/logos/isin/IE000I8KRLL9?format=png",
      "https://assets.parqet.com/logos/symbol/SEMI?format=png",
      "https://www.google.com/s2/favicons?domain=example.com&sz=128",
    ]);
  });

  it("falls back to 204 when every candidate returns a mislabelled body", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("<svg xmlns='http://www.w3.org/2000/svg'></svg>", {
        headers: { "Content-Type": "image/png" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("AAPL?domain=example.com", "AAPL");
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe(LOGO_FALLBACK_HEADERS["Cache-Control"]);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops redirect loops after the hop limit and falls back to 204", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { Location: "https://assets.parqet.com/logos/symbol/AAPL?format=png" },
        status: 302,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLogo("AAPL", "AAPL");
    expect(response.status).toBe(204);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
