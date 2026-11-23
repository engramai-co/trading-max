import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
  backendUrl: () => "http://127.0.0.1:8421",
}));
import { DELETE as deleteConversations } from "@/app/api/backend/assistant/conversations/route";
import { POST as importCfdCsv } from "@/app/api/backend/imports/trading212/cfd/route";
import {
  privateJsonResponse,
  proxyBackendResponse,
  proxyDeleteRequest,
  proxyJsonRequest,
  proxyRawRequest,
  validateWriteRequest,
} from "./backend-proxy";

const payload = { points: Array.from({ length: 500 }, (_, i) => ({ at: i, value: i / 10, source: "synthetic" })) };

afterEach(() => {
  backendFetch.mockReset();
  vi.unstubAllEnvs();
});

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

describe("write request origin and content-type guard", () => {
  const writeRequest = (headers: HeadersInit = {}, url = "http://127.0.0.1:3415/api/backend/watchlist", method = "POST") =>
    new Request(url, {
      method,
      headers,
      body: method === "DELETE" ? undefined : '{"ticker":"AAPL"}',
    });

  it("accepts same-origin writes directly and behind Tailscale serve forwarded headers", async () => {
    backendFetch.mockImplementation(async () => Response.json({ ok: true }));

    const cases: Array<[string, Request]> = [
      ["direct Sec-Fetch-Site same-origin + Origin", writeRequest({
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://127.0.0.1:3415",
      })],
      ["Sec-Fetch-Site none without Origin", writeRequest({
        "Content-Type": "application/json; charset=utf-8",
        "Sec-Fetch-Site": "none",
      })],
      ["older WebKit direct Origin without Sec-Fetch-Site", writeRequest({
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3415",
      })],
      ["older WebKit behind Tailscale serve (X-Forwarded-Host + X-Forwarded-Proto)", writeRequest({
        "Content-Type": "application/json",
        Origin: "https://workspace.example.net",
        "X-Forwarded-Host": "workspace.example.net",
        "X-Forwarded-Proto": "https",
      })],
      ["Tailscale serve with default HTTPS port and proxy chain", writeRequest({
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: "https://workspace.example.net",
        "X-Forwarded-Host": "workspace.example.net:443, 127.0.0.1:3415",
        "X-Forwarded-Proto": "https, http",
      })],
      ["Tailscale serve non-default HTTPS port", writeRequest({
        "Content-Type": "application/json",
        Origin: "https://workspace.example.net:8443",
        "X-Forwarded-Host": "workspace.example.net:8443",
        "X-Forwarded-Proto": "https",
      })],
      ["Host header + X-Forwarded-Proto fallback", writeRequest({
        "Content-Type": "application/json",
        Host: "workspace.example.net",
        "X-Forwarded-Proto": "https",
        Origin: "https://workspace.example.net",
      })],
      ["IPv6 loopback same-origin", writeRequest(
        { "Content-Type": "application/json", Origin: "http://[::1]:3415" },
        "http://[::1]:3415/api/backend/watchlist",
      )],
    ];

    for (const [label, request] of cases) {
      const response = await proxyJsonRequest("/v1/watchlist", request, "POST");
      expect(response.status, label).toBe(200);
    }
    expect(backendFetch).toHaveBeenCalledTimes(cases.length);
  });

  it("accepts server-to-server requests with no browser origin or fetch metadata headers", async () => {
    backendFetch.mockResolvedValueOnce(Response.json({ ok: true }));
    const postResponse = await proxyJsonRequest(
      "/v1/watchlist",
      writeRequest({ "Content-Type": "application/json" }),
      "POST",
    );
    expect(postResponse.status).toBe(200);

    backendFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const deleteResponse = await proxyDeleteRequest(
      "/v1/assistant/conversations",
      writeRequest({}, "http://127.0.0.1:3415/api/backend/assistant/conversations", "DELETE"),
    );
    expect(deleteResponse.status).toBe(204);
    expect(backendFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Sec-Fetch-Site cross-site", { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" }],
    ["Sec-Fetch-Site same-site (other port or subdomain)", { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:9999" }],
    ["Sec-Fetch-Site blank", { "Content-Type": "application/json", "Sec-Fetch-Site": "" }],
    ["Sec-Fetch-Site uppercase SAME-ORIGIN", { "Content-Type": "application/json", "Sec-Fetch-Site": "SAME-ORIGIN", Origin: "http://127.0.0.1:3415" }],
    ["Sec-Fetch-Site uppercase NONE", { "Content-Type": "application/json", "Sec-Fetch-Site": "NONE" }],
    ["mismatched Origin without Sec-Fetch-Site", { "Content-Type": "application/json", Origin: "https://evil.test" }],
    ["Origin port mismatch without Sec-Fetch-Site", { "Content-Type": "application/json", Origin: "http://127.0.0.1:9999" }],
    ["Origin localhost vs 127.0.0.1 mismatch", { "Content-Type": "application/json", Origin: "http://localhost:3415" }],
    ["Origin scheme downgrade behind Tailscale serve", { "Content-Type": "application/json", Origin: "http://workspace.example.net", "X-Forwarded-Host": "workspace.example.net", "X-Forwarded-Proto": "https" }],
    ["Origin null (sandboxed iframe / file)", { "Content-Type": "application/json", Origin: "null" }],
    ["Origin with path or credentials", { "Content-Type": "application/json", Origin: "http://127.0.0.1:3415/evil" }],
    ["invalid X-Forwarded-Proto", { "Content-Type": "application/json", Origin: "https://workspace.example.net", "X-Forwarded-Host": "workspace.example.net", "X-Forwarded-Proto": "javascript" }],
    ["invalid X-Forwarded-Host with path", { "Content-Type": "application/json", Origin: "https://workspace.example.net", "X-Forwarded-Host": "workspace.example.net/evil", "X-Forwarded-Proto": "https" }],
  ])("rejects %s with 403 plain JSON before reading body or contacting backend", async (_label, headers) => {
    const read = vi.fn();
    const request = new Request("http://127.0.0.1:3415/api/backend/watchlist", {
      method: "POST",
      headers,
      body: new ReadableStream({ pull(controller) { read(); controller.close(); } }, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit);
    const textSpy = vi.spyOn(request, "text");

    const response = await proxyJsonRequest("/v1/watchlist", request, "POST");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ detail: { code: expect.any(String), message: expect.any(String) } });
    expect(textSpy).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("accepts Sec-Fetch-Site same-origin behind a Host-rewriting proxy without forwarded headers, and judges by Origin when absent", async () => {
    backendFetch.mockResolvedValueOnce(Response.json({ ok: true }));
    const proxied = await proxyJsonRequest(
      "/v1/watchlist",
      writeRequest({
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: "https://workspace.example.net",
        Host: "127.0.0.1:3415",
      }),
      "POST",
    );
    expect(proxied.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledOnce();

    const withoutFetchSite = await proxyJsonRequest(
      "/v1/watchlist",
      writeRequest({
        "Content-Type": "application/json",
        Origin: "https://workspace.example.net",
        Host: "127.0.0.1:3415",
      }),
      "POST",
    );
    expect(withoutFetchSite.status).toBe(403);
    expect(backendFetch).toHaveBeenCalledOnce();
  });

  it("rejects non-JSON Content-Type on JSON write routes with 415 before calling backend", async () => {
    const cases: HeadersInit[] = [
      {},
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
      { "Content-Type": "multipart/form-data; boundary=abc", Origin: "http://127.0.0.1:3415" },
    ];
    for (const headers of cases) {
      const response = await proxyJsonRequest("/v1/watchlist", writeRequest(headers), "POST");
      expect(response.status).toBe(415);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("rejects mixed-case duplicate Content-Type headers with 415 while allowing commas inside quoted parameters", async () => {
    const rejectedCases: HeadersInit[] = [
      [["Content-Type", "application/json; charset=utf-8"], ["content-type", "text/plain"]],
      [["Content-Type", "application/json; charset=utf-8"], ["CONTENT-TYPE", "application/json"]],
      [["Content-Type", 'application/json; param="unclosed'], ["content-type", "text/plain"]],
      [["Content-Type", 'application/json; param="unclosed'], ["content-type", 'text/plain; other="unclosed']],
      { "Content-Type": 'application/json; param="a\\",b", text/plain' },
      { "Content-Type": 'application/json; param="a\\\\", text/plain' },
      { "Content-Type": "application/json, text/plain" },
    ];
    for (const headers of rejectedCases) {
      const response = await proxyJsonRequest("/v1/watchlist", writeRequest(headers), "POST");
      expect(response.status).toBe(415);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(backendFetch).not.toHaveBeenCalled();

    backendFetch.mockImplementation(async () => Response.json({ ok: true }));
    const quotedCommaCases: HeadersInit[] = [
      { "Content-Type": 'application/json; profile="https://example.test/a,b"; charset=utf-8' },
      { "Content-Type": 'application/json; param="a\\",b"; charset=utf-8' },
    ];
    for (const headers of quotedCommaCases) {
      const response = await proxyJsonRequest("/v1/watchlist", writeRequest(headers), "POST");
      expect(response.status).toBe(200);
    }
    expect(backendFetch).toHaveBeenCalledTimes(quotedCommaCases.length);
  });

  it("enforces exact supervised loopback origin and host when desktop supervisor is active", async () => {
    vi.stubEnv("HOSTNAME", "127.0.0.1");
    vi.stubEnv("PORT", "43123");
    vi.stubEnv("TRADING_MAX_DESKTOP_SUPERVISOR_PID", "9999");

    expect(validateWriteRequest(writeRequest(
      { "Content-Type": "application/json", Origin: "http://127.0.0.1:43123" },
      "http://127.0.0.1:43123/api/backend/local-workspace/refresh",
    ))).toBeNull();

    // DNS rebinding attempt using an attacker hostname pointing to 127.0.0.1.
    const rebind = validateWriteRequest(writeRequest(
      {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://rebind.evil.test:43123",
        Host: "rebind.evil.test:43123",
      },
      "http://rebind.evil.test:43123/api/backend/local-workspace/refresh",
    ));
    expect(rebind?.status).toBe(403);

    // Spoofed X-Forwarded-Host is ignored in supervised loopback mode.
    const spoofed = validateWriteRequest(writeRequest(
      {
        "Content-Type": "application/json",
        Origin: "https://evil.test",
        "X-Forwarded-Host": "evil.test",
        "X-Forwarded-Proto": "https",
      },
      "http://127.0.0.1:43123/api/backend/local-workspace/refresh",
    ));
    expect(spoofed?.status).toBe(403);
  });

  it("rejects cross-site DELETE requests before contacting backend", async () => {
    const response = await proxyDeleteRequest(
      "/v1/settings/integrations/alpaca",
      writeRequest(
        { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" },
        "http://127.0.0.1:3415/api/backend/settings/integrations/alpaca",
        "DELETE",
      ),
    );
    expect(response.status).toBe(403);

    const routeResponse = await deleteConversations(writeRequest(
      { Origin: "https://evil.test" },
      "http://127.0.0.1:3415/api/backend/assistant/conversations",
      "DELETE",
    ));
    expect(routeResponse.status).toBe(403);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("guards raw CSV uploads by origin and media type while preserving text/csv", async () => {
    backendFetch.mockResolvedValue(Response.json({ status: "imported" }));

    const crossSite = await importCfdCsv(new Request("http://127.0.0.1:3415/api/backend/imports/trading212/cfd", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "text/csv", "X-Trading-Max-Filename": "cfd.csv" },
      body: "a,b\n1,2\n",
    }));
    expect(crossSite.status).toBe(403);

    const wrongType = await importCfdCsv(new Request("http://127.0.0.1:3415/api/backend/imports/trading212/cfd", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain", "X-Trading-Max-Filename": "cfd.csv" },
      body: "a,b\n1,2\n",
    }));
    expect(wrongType.status).toBe(415);

    const rawCrossSite = await proxyRawRequest(
      "/v1/imports/trading212/cfd",
      new Request("http://127.0.0.1:3415/api/backend/imports/trading212/cfd", {
        method: "POST",
        headers: { Origin: "https://evil.test", "Content-Type": "text/csv" },
        body: "a,b\n1,2\n",
      }),
      "POST",
      { "Content-Type": "text/csv" },
    );
    expect(rawCrossSite.status).toBe(403);
    expect(backendFetch).not.toHaveBeenCalled();

    const accepted = await importCfdCsv(new Request("http://127.0.0.1:3415/api/backend/imports/trading212/cfd", {
      method: "POST",
      headers: {
        Origin: "https://workspace.example.net",
        "X-Forwarded-Host": "workspace.example.net",
        "X-Forwarded-Proto": "https",
        "Content-Type": "text/csv; charset=utf-8",
        "X-Trading-Max-Filename": "cfd.csv",
      },
      body: "a,b\n1,2\n",
    }));
    expect(accepted.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledOnce();
  });
});
