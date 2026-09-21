import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./backend", () => ({ backendFetch: vi.fn() }));
import { backendFetch } from "./backend";
import { readPreparedHistory } from "./history-server";
import { GET } from "@/app/api/backend/dashboard/history/route";

const fetchMock = vi.mocked(backendFetch);
const selection = (runId: string) => ({ runId, range: "6M" as const, scope: "total" as const });
const response = (runId: string) => new Response(JSON.stringify({ runId, brokerAsOf: "2026-09-18", dataRevision: runId, nav: [], intradayNav: [] }));

describe("snapshot-pinned history queries", () => {
  beforeEach(() => fetchMock.mockReset());
  it("shares identical inflight reads and keeps revisions separate", async () => {
    fetchMock.mockResolvedValueOnce(response("cache-one")).mockResolvedValueOnce(response("cache-two"));
    const [a, b] = await Promise.all([readPreparedHistory(selection("cache-one")), readPreparedHistory(selection("cache-one"))]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("run_id=cache-one");
    const next = await readPreparedHistory(selection("cache-two"));
    expect(next.chart.runId).toBe("cache-two");
    expect((await readPreparedHistory(selection("cache-one"))).chart.runId).toBe("cache-one");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rebuilds evicted views from the requested version without substituting latest", async () => {
    fetchMock.mockImplementation(async (path) => response(new URL(`http://backend${path}`).searchParams.get("run_id")!));
    for (const run of ["eviction-a", "eviction-b", "eviction-c", "eviction-a"]) await readPreparedHistory(selection(run));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("run_id=eviction-a");
  });
  it("rejects invalid input before reading any private data", async () => {
    for (const query of ["", "runId=..%2Fsecret", "runId=abc&scope=unknown", "runId=abc&range=2Y", "runId=abc&page=0", "runId=abc&page=1.5"]) {
      expect((await GET(new Request(`http://localhost/api/backend/dashboard/history?${query}`))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves missing-snapshot failure and private response policy", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await GET(new Request("http://localhost/?runId=missing-revision"));
    expect(result.status).toBe(404);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("does not display a response for a different snapshot", async () => {
    fetchMock.mockResolvedValueOnce(response("unexpected"));
    expect((await GET(new Request("http://localhost/?runId=expected"))).status).toBe(502);
  });
  it("serves exact pages through the same pinned cached view", async () => {
    fetchMock.mockResolvedValueOnce(response("page-revision"));
    const chart = await GET(new Request("http://localhost/?runId=page-revision"));
    const page = await GET(new Request("http://localhost/?runId=page-revision&page=1"));
    expect((await chart.json()).runId).toBe("page-revision");
    expect(await page.json()).toMatchObject({ runId: "page-revision", total: 0, pageSize: 20, points: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
