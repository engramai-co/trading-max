import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const backendFetch = vi.fn();
vi.mock("@/lib/backend", () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
  backendUrl: () => "http://127.0.0.1:8421",
}));
import { ASSISTANT_MAX_REQUEST_BYTES, proxyAssistantChat } from "./assistant-proxy";

afterEach(() => backendFetch.mockReset());

function chat(body: string, query = "") {
  return new Request(`http://localhost/api/backend/assistant/chat${query}`, { method: "POST", body });
}

describe("assistant chat proxy", () => {
  it("streams the backend events through unchanged and only forwards known query keys", async () => {
    const encoder = new TextEncoder();
    const events = ['data: {"type":"start"}\n\n', 'data: {"type":"text-delta","delta":"Hi"}\n\n'];
    backendFetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "Set-Cookie": "x=1" } }));

    const response = await proxyAssistantChat(chat('{"id":"c1"}', "?page=overview&tz=Europe%2FLondon&format=references&evil=1"));
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/assistant/chat?page=overview&tz=Europe%2FLondon&format=references");
    expect(new TextDecoder().decode(init.body)).toBe('{"id":"c1"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe(events.join(""));
  });

  it("rejects oversized requests before contacting the backend", async () => {
    const response = await proxyAssistantChat(chat("x".repeat(ASSISTANT_MAX_REQUEST_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("passes backend refusals through with their status", async () => {
    backendFetch.mockResolvedValue(Response.json({ detail: { code: "assistant_disabled" } }, { status: 403 }));
    const response = await proxyAssistantChat(chat('{"id":"c1"}'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: { code: "assistant_disabled" } });
  });
});
