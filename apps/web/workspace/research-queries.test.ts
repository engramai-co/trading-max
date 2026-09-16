import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { researchLensQuery, researchPriceQuery } from "./research-queries";

afterEach(() => vi.unstubAllGlobals());

describe("research requests", () => {
  it("coalesces equivalent consumers without mixing tickers or history windows", async () => {
    const client = new QueryClient();
    const fetch = vi.fn(async () => Response.json({ ticker: "TEST", points: [] }));
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      client.fetchQuery(researchPriceQuery("TEST", "study-1")),
      client.fetchQuery(researchPriceQuery("TEST", "study-1", "1d")),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.fetchQuery(researchPriceQuery("TEST", "study-1", "1d", "3M"));
    await client.fetchQuery(researchPriceQuery("OTHER", "study-1"));
    expect(fetch).toHaveBeenCalledTimes(3);
    client.clear();
  });

  it("aborts an obsolete request all the way to fetch", async () => {
    const client = new QueryClient();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    })));
    const request = client.fetchQuery(researchLensQuery("TEST", "overview", "study-1", "summary"));
    const result = request.catch(() => "cancelled");
    await client.cancelQueries({ queryKey: ["workspace-research", "TEST"] });
    expect(signal?.aborted).toBe(true);
    expect(await result).toBe("cancelled");
    client.clear();
  });
});
