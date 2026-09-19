import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { privateJsonResponse, proxyBackendResponse } from "./backend-proxy";

const payload = { points: Array.from({ length: 500 }, (_, i) => ({ at: i, value: i / 10, source: "synthetic" })) };

describe("private response compression", () => {
  it.each([
    ["gzip, br", "br"], ["br;q=0, gzip", "gzip"],
    ["br;q=0.4, gzip;q=0.8", "gzip"], ["br;q=1, gzip;q=0.2", "br"],
    ["br;q=invalid, gzip;q=0", null], ["identity", null],
    ["*;q=1, br;q=0", "gzip"], ["br;q=0, gzip;q=0", null],
  ])("negotiates %s and preserves every JSON byte", async (accept, coding) => {
    const response = privateJsonResponse(new Request("http://localhost/", { headers: { "Accept-Encoding": accept! } }), payload);
    expect(response.headers.get("content-encoding")).toBe(coding);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    const bytes = Buffer.from(await response.arrayBuffer());
    const raw = coding === "br" ? brotliDecompressSync(bytes) : coding === "gzip" ? gunzipSync(bytes) : bytes;
    expect(raw.toString()).toBe(JSON.stringify(payload));
    if (coding) expect(bytes.length).toBeLessThan(raw.length / 2);
  });

  it("keeps small and empty responses plain and preserves upstream timing/status", async () => {
    const response = proxyBackendResponse(new Response("{}", { status: 202, headers: { "Content-Length": "2", "Server-Timing": "query;dur=3.2" } }), "application/json", "br", 7);
    expect(response.status).toBe(202);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("server-timing")).toContain("query;dur=3.2");
    expect(await response.text()).toBe("{}");
    expect(proxyBackendResponse(new Response(null, { status: 204 }), "application/json", "br").status).toBe(204);
  });

  it("propagates an upstream stream failure", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("synthetic upstream failure")); } });
    const response = proxyBackendResponse(new Response(body), "application/json", "br");
    await expect(response.arrayBuffer()).rejects.toThrow("synthetic upstream failure");
  });

  it("keeps known-length history streams close to whole-response compression", async () => {
    const sources = Array.from({ length: 2_048 }, (_, i) => createHash("sha256").update("synthetic-" + i).digest("hex"));
    const bytes = Buffer.from(JSON.stringify({ points: Array.from({ length: 6_000 }, (_, i) => ({
      bucket_at: new Date(Date.UTC(2026, 0, 1) + i * 600_000).toISOString(),
      observed_at: new Date(Date.UTC(2026, 0, 1) + i * 600_000 + 8_000).toISOString(),
      nav_gbp: 10_000 + Math.sin(i / 100) * 1_000, net_pnl_gbp: i / 13,
      flow_verified: i % 30 !== 0,
      source_artifact_ids: [sources[Math.floor(i / 100) % 2_048], sources[i % 2_048]],
    })) }));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let at = 0; at < bytes.length; at += 65_536) controller.enqueue(bytes.subarray(at, at + 65_536));
      controller.close();
    } });
    const response = proxyBackendResponse(new Response(body, {
      headers: { "Content-Length": String(bytes.length) },
    }), "application/json", "br");
    const compressed = Buffer.from(await response.arrayBuffer());
    const reference = brotliCompressSync(bytes, { params: {
      [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    } });
    expect(brotliDecompressSync(compressed).equals(bytes)).toBe(true);
    expect(compressed.length).toBeLessThanOrEqual(reference.length * 1.03);
  });

  it("cancels the upstream reader when the client leaves", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = proxyBackendResponse(new Response(body), "application/json", "br");
    await response.body!.cancel();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
