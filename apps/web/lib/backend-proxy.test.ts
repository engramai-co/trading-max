import { brotliDecompressSync, gunzipSync } from "node:zlib";
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

  it("cancels the upstream reader when the client leaves", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = proxyBackendResponse(new Response(body), "application/json", "br");
    await response.body!.cancel();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
