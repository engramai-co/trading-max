import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/backend/dashboard/lens/[view]/route";

vi.mock("server-only", () => ({}));
const { backendFetch, remember } = vi.hoisted(() => ({backendFetch:vi.fn(), remember:vi.fn()}));
vi.mock("@/lib/backend", () => ({backendFetch, backendUrl:() => "http://127.0.0.1:8421"}));
vi.mock("@/lib/snapshot-cache-server", () => ({rememberDesktopSnapshotResponse:remember}));
afterEach(() => vi.clearAllMocks());

it("forwards a retained publication to the API without replacing the latest lens cache", async () => {
  const request = new Request("http://localhost/api/backend/dashboard/lens/analytics?scope=isa&range=ALL&detail=summary&runId=original");
  backendFetch.mockResolvedValue(Response.json({runId:"original"}));
  const response = await GET(request, {params:Promise.resolve({view:"analytics"})});
  expect(response.status).toBe(200);
  const upstream = new URL(backendFetch.mock.calls[0][0], "http://localhost");
  expect(upstream.pathname).toBe("/v1/dashboard/lens/analytics");
  expect(Object.fromEntries(upstream.searchParams)).toEqual({run_id:"original",scope:"isa",range:"ALL",detail:"summary"});
  expect(remember.mock.calls[0][0]).toEqual(["dashboard-lens","snapshot","original","analytics",null,{scope:"isa",range:"ALL",detail:"summary"}]);
});
