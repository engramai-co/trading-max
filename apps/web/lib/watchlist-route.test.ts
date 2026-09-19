import { beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend-proxy", () => ({ proxyToBackend: proxy }));

import { POST } from "@/app/api/backend/watchlist/[ticker]/route";

const context = { params: Promise.resolve({ ticker: "BRK.B" }) };
const request = (body: string) => new Request("http://localhost/api/backend/watchlist/BRK.B", {
  method: "POST", headers: { "Content-Type": "application/json" }, body,
});

describe("watchlist action proxy", () => {
  beforeEach(() => {
    proxy.mockReset();
    proxy.mockResolvedValue(Response.json({ status: "ok" }));
  });

  it.each(["refresh", "remove", "move"])("forwards the supported %s action", async (action) => {
    const response = await POST(request(JSON.stringify({ action, categoryId: "technology" })), context);
    expect(response.status).toBe(200);
    expect(proxy).toHaveBeenCalledWith(`/v1/watchlist/BRK.B/${action}`, {
      method: "POST",
      body: action === "move" ? JSON.stringify({ categoryId: "technology" }) : undefined,
      headers: action === "move" ? { "Content-Type": "application/json" } : undefined,
    });
  });

  it("keeps refresh as the default action", async () => {
    await POST(request("{}"), context);
    expect(proxy.mock.calls[0][0]).toBe("/v1/watchlist/BRK.B/refresh");
  });

  it.each(["{", "null", "[]", '"refresh"', '{"action":"../../jobs/refresh"}', '{"action":"delete"}', '{"action":true}', '{"action":null}'])
    ("rejects invalid input before calling the backend: %s", async (body) => {
      const response = await POST(request(body), context);
      expect(response.status).toBe(400);
      expect(proxy).not.toHaveBeenCalled();
    });
});
