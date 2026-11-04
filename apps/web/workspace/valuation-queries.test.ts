import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchLensSnapshot } from "@/lib/types";
import { createQueryClient } from "@/ui/query-client";
import type { Preview } from "./research-facts";
import {
  editorIdentity,
  loadedValuationQuery,
  previewRequest,
  valuationDefaultsQuery,
  valuationPreviewQuery,
  workbenchState,
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

/** The valuation service: previews at the broker price of the moment, or an outage. */
function service() {
  const state = { spot: spot100, bodies: [] as PreviewRequest[], defaultsDown: false };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as PreviewRequest) : null;
    if (!body && state.defaultsDown)
      return Response.json({ detail: "synthetic outage" }, { status: 503 });
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

/**
 * The workbench's queries for one security: its default preview at the
 * header's spot and the last one of its research that loaded.
 */
function workbench(client: ReturnType<typeof createQueryClient>, data: ResearchLensSnapshot) {
  const defaults = new QueryObserver(client, valuationDefaultsQuery(data, spot100));
  const loaded = new QueryObserver(client, loadedValuationQuery(data));
  const stop = [defaults.subscribe(() => {}), loaded.subscribe(() => {})];
  return {
    defaults,
    loaded,
    view: () => workbenchState(defaults.getCurrentResult(), loaded.getCurrentResult().data),
    stop: () => stop.forEach((unsubscribe) => unsubscribe()),
  };
}

/** The owner edits at 100, then the broker price moves to 120 and the refresh fails. */
async function editThenFail() {
  const client = createQueryClient();
  const { state } = service();
  const page = workbench(client, lens);
  await vi.waitFor(() => expect(page.view()).toMatchObject({ view: "editor" }));
  const editing = page.view();
  if (editing.view !== "editor") throw new Error("no editor");
  await client.fetchQuery(valuationPreviewQuery(editing.preview, edited(0.2)));
  state.spot = spot120;
  state.defaultsDown = true;
  page.defaults.setOptions(valuationDefaultsQuery(lens, spot120));
  await vi.waitFor(() => expect(page.defaults.getCurrentResult().isError).toBe(true));
  return { client, state, page, editing };
}

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

  it("keeps the editor, its edits and the last preview through a failed refresh", async () => {
    const { client, page, editing } = await editThenFail();
    const failed = page.view();
    // The editor stays mounted on the last preview, with the failure noted beside it.
    expect(failed).toMatchObject({ view: "editor", refreshFailed: true, preview: { basis: { spot: 100 } } });
    if (failed.view !== "editor" || editing.view !== "editor") throw new Error("no editor");
    expect(editorIdentity(failed.preview)).toBe(editorIdentity(editing.preview));
    // The edited scenario keeps its result on that preview's basis.
    const kept = client.getQueryData(valuationPreviewQuery(failed.preview, edited(0.2)).queryKey);
    expect(kept?.basis.spot).toBe(100);
    page.stop();
    client.clear();
  });

  it("recomputes the edits at the new spot when a retry succeeds, without resetting them", async () => {
    const { client, state, page, editing } = await editThenFail();
    state.defaultsDown = false;
    await page.defaults.refetch();
    const recovered = page.view();
    expect(recovered).toMatchObject({ view: "editor", refreshFailed: false, preview: { basis: { spot: 120 } } });
    if (recovered.view !== "editor" || editing.view !== "editor") throw new Error("no editor");
    // Same research and defaults: the editor and its assumptions stay.
    expect(editorIdentity(recovered.preview)).toBe(editorIdentity(editing.preview));
    const revalued = await client.fetchQuery(valuationPreviewQuery(recovered.preview, edited(0.2)));
    expect(revalued.basis.spot).toBe(120);
    page.stop();
    client.clear();
  });

  it("never shows one security's preview for another", async () => {
    const { client, page } = await editThenFail();
    const other = {
      ...lens,
      ticker: "OTHER",
      context: { quote: { id: "quote-9" } },
    } as unknown as ResearchLensSnapshot;
    page.defaults.setOptions(valuationDefaultsQuery(other, spot120));
    page.loaded.setOptions(loadedValuationQuery(other));
    expect(page.view()).toEqual({ view: "pending" });
    // The first load of a security that fails is the full error state.
    await vi.waitFor(() => expect(page.view()).toEqual({ view: "error" }));
    // Back on the first security, its own last preview returns at once,
    // although the service is still down.
    page.defaults.setOptions(valuationDefaultsQuery(lens, spot120));
    page.loaded.setOptions(loadedValuationQuery(lens));
    expect(page.view()).toMatchObject({ view: "editor", preview: { basis: { ticker: "SYNT", spot: 100 } } });
    page.stop();
    client.clear();
  });
});
