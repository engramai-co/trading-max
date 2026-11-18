import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/backend/publications/[runId]/events/upcoming/route";

vi.mock("server-only", () => ({}));
const { backendFetch } = vi.hoisted(() => ({backendFetch:vi.fn()}));
vi.mock("@/lib/backend", () => ({backendFetch, backendUrl:() => "http://127.0.0.1:8421"}));
afterEach(() => vi.clearAllMocks());
const get = (query:string) => GET(new Request("http://localhost/api/backend/publications/saved/events/upcoming?" + query),
  {params:Promise.resolve({runId:"saved"})});

it("rejects calendar browsing before forwarding a retained citation request", async () => {
  backendFetch.mockResolvedValue(Response.json({}));
  for (const query of ["scope=household&start=2026-01-01&end=2026-12-31","ticker=WATCH","eventId=ev_row",
    "ticker=WATCH&eventId=ev_row&scope=household","ticker=WATCH&eventId=ev_row&eventId=ev_other"]) {
    expect((await get(query)).status).toBe(400);
  }
  expect(backendFetch).not.toHaveBeenCalled();
});

it.each(["earnings", "ex_dividend", "dividend_pay", "dividend"])("forwards one ticker and %s identity to the single-row backend", async kind => {
  backendFetch.mockResolvedValue(Response.json({ticker:"WATCH",evidence_id:"ev_row"}));
  const response = await get("ticker=WATCH&eventId=ev_row&kind=" + kind);
  expect(response.status).toBe(200);
  const upstream = new URL(backendFetch.mock.calls[0][0],"http://localhost");
  expect(upstream.pathname).toBe("/v1/snapshots/saved/events/cited");
  expect(Object.fromEntries(upstream.searchParams)).toEqual({ticker:"WATCH",event_id:"ev_row",kind});
});
