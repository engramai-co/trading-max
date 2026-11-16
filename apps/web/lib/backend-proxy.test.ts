import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { privateJsonResponse, proxyBackendResponse } from "./backend-proxy";

const payload = { points: Array.from({ length: 500 }, (_, i) => ({ at: i, value: i / 10, source: "synthetic" })) };

// Next.js compresses route responses once, so every body leaves the handler plain.
describe("private backend responses", () => {
  it("returns plain private JSON with the requested status", async () => {
    const response = privateJsonResponse(payload, { status: 400 });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(JSON.stringify(payload));
  });

  it("passes upstream bytes through unchanged", async () => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let at = 0; at < bytes.length; at += 4_096) controller.enqueue(bytes.subarray(at, at + 4_096));
      controller.close();
    } });
    const response = proxyBackendResponse(new Response(body, { headers: { "Content-Length": String(bytes.length) } }));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("preserves upstream status and timing", async () => {
    const response = proxyBackendResponse(
      new Response("{}", { status: 202, headers: { "Server-Timing": "query;dur=3.2" } }),
      "application/json",
      7,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("server-timing")).toBe("query;dur=3.2, backend_roundtrip;dur=7.0");
    expect(await response.text()).toBe("{}");
    expect(proxyBackendResponse(new Response(null, { status: 204 })).status).toBe(204);
  });

  it("propagates an upstream stream failure", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("synthetic upstream failure")); } });
    await expect(proxyBackendResponse(new Response(body)).arrayBuffer()).rejects.toThrow("synthetic upstream failure");
  });

  it("cancels the upstream reader when the client leaves", async () => {
    const cancelled = vi.fn();
    const response = proxyBackendResponse(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
    await response.body!.cancel();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
