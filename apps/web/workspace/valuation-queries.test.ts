import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchLensSnapshot } from "@/lib/types";
import { createQueryClient } from "@/ui/query-client";
import type { Preview } from "./research-facts";
import {
  editorIdentity,
  previewRequest,
  valuationDefaultsQuery,
  valuationPreviewQuery,
  type PreviewRequest,
} from "./valuation-queries";

afterEach(() => vi.unstubAllGlobals());

// A synthetic held security whose broker price moves from 100 to 120.
const lens = {
  ticker: "SYNT",
  context: { quote: { id: "quote-1" } },
  financialFacts: { version: "facts-1" },
} as unknown as ResearchLensSnapshot;
const inputs = {
  revenueCagr: 0.1,
  targetFcfMargin: 0.15,
  discountRate: 0.1,
  exitFcfMultiple: 15,
  shareCagr: 0,
};
const spot100 = { source: "broker" as const, price: 100, asOf: "2026-11-04T15:40:00Z" };
const spot120 = { source: "broker" as const, price: 120, asOf: "2026-11-04T15:50:00Z" };

/** A preview as the service answers it: its id covers the basis, spot included. */
function preview(spot: typeof spot100, scenarios: Record<string, typeof inputs> = {}): Preview {
  return {
    id: `preview-${spot.price}`,
    basis: {
      ticker: "SYNT",
      quoteId: "quote-1",
      dataVersion: "research-1",
      currency: "USD",
      spot: spot.price,
      spotSource: spot.source,
      spotAsOf: spot.asOf,
    },
    horizon: 5,
    scenarios: Object.fromEntries(
      ["bear", "base", "bull"].map((key) => [key, { inputs: scenarios[key] ?? inputs }]),
    ),
    references: [],
    defaultSource: "configured-scenarios",
  } as unknown as Preview;
}

/** The valuation service: previews at the broker price of the moment. */
function service() {
  const state = { spot: spot100, bodies: [] as PreviewRequest[] };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as PreviewRequest) : null;
    if (body) state.bodies.push(body);
    return Response.json(preview(state.spot, body?.scenarios));
  });
  vi.stubGlobal("fetch", fetch);
  return { state, fetch };
}

const edited = (revenueCagr: number): PreviewRequest => ({
  ...previewRequest(preview(spot100)),
  scenarios: { bear: inputs, base: { ...inputs, revenueCagr }, bull: inputs },
});

describe("valuation previews", () => {
  it("fetches the defaults again when the broker price moves from 100 to 120", async () => {
    const client = createQueryClient();
    const { state, fetch } = service();
    expect((await client.fetchQuery(valuationDefaultsQuery(lens, spot100))).basis.spot).toBe(100);
    state.spot = spot120;
    // Within the stale time, a key without the spot would answer 100 from the cache.
    expect((await client.fetchQuery(valuationDefaultsQuery(lens, spot120))).basis.spot).toBe(120);
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.fetchQuery(valuationDefaultsQuery(lens, spot120));
    expect(fetch).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it("keeps the editor while a new spot loads, never borrowing another security's preview", async () => {
    const client = createQueryClient();
    const { state } = service();
    const observer = new QueryObserver(client, valuationDefaultsQuery(lens, spot100));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.basis.spot).toBe(100));
    state.spot = spot120;
    observer.setOptions(valuationDefaultsQuery(lens, spot120));
    // The same research's preview stands in, so the editor never sees a pending state.
    expect(observer.getCurrentResult()).toMatchObject({
      isPending: false,
      isPlaceholderData: true,
      data: { basis: { spot: 100 } },
    });
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.basis.spot).toBe(120));
    // A new spot keeps the editor and its assumptions; new research resets it.
    const moved = observer.getCurrentResult().data!;
    expect(editorIdentity(moved)).toBe(editorIdentity(preview(spot100)));
    const revised = { ...moved, basis: { ...moved.basis, dataVersion: "research-2" } };
    expect(editorIdentity(revised)).not.toBe(editorIdentity(moved));
    observer.setOptions(valuationDefaultsQuery({ ...lens, ticker: "OTHER" }, spot120));
    expect(observer.getCurrentResult()).toMatchObject({ isPlaceholderData: false, data: undefined });
    unsubscribe();
    client.clear();
  });

  it("recomputes revisited assumptions at the new spot with the research's data version", async () => {
    const client = createQueryClient();
    const { state } = service();
    const at100 = preview(spot100);
    expect((await client.fetchQuery(valuationPreviewQuery(at100, edited(0.2)))).basis.spot).toBe(100);
    await client.fetchQuery(valuationPreviewQuery(at100, edited(0.3)));
    state.spot = spot120;
    const at120 = preview(spot120);
    // Both earlier assumptions are revisited after the broker refresh.
    expect((await client.fetchQuery(valuationPreviewQuery(at120, edited(0.2)))).basis.spot).toBe(120);
    expect((await client.fetchQuery(valuationPreviewQuery(at120, edited(0.3)))).basis.spot).toBe(120);
    expect(state.bodies).toHaveLength(4);
    // Unchanged assumptions at the same spot read the cache.
    await client.fetchQuery(valuationPreviewQuery(at120, edited(0.2)));
    expect(state.bodies).toHaveLength(4);
    // The spot itself keys the cache, even where the service's id would not change.
    const sameId = { ...at100, basis: at120.basis };
    expect((await client.fetchQuery(valuationPreviewQuery(sameId, edited(0.3)))).basis.spot).toBe(120);
    expect(state.bodies).toHaveLength(5);
    // A broker refresh never changes the data version a 409 is decided on.
    expect(new Set(state.bodies.map((body) => body.dataVersion))).toEqual(new Set(["research-1"]));
    client.clear();
  });
});
