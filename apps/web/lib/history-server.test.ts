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
    const runs = Array.from({ length: 9 }, (_, index) => "eviction-" + index);
    for (const run of [...runs, "eviction-0"]) await readPreparedHistory(selection(run));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("run_id=eviction-0");
  });
  it("rejects invalid input before reading any private data", async () => {
    const at = "opening=2026-10-29T00%3A10%3A00Z";
    for (const query of [
      "", "runId=..%2Fsecret", "runId=abc&scope=unknown", "runId=abc&range=2Y", "runId=abc&page=0", "runId=abc&page=1.5",
      "runId=abc&opening=yesterday", "runId=abc&opening=2026-10-29", `runId=abc&page=1&${at}`, `runId=abc&${at}&${at}&${at}`,
      // No offset, so the server's own zone would decide; an impossible date; 24:00; an impossible offset.
      "runId=abc&opening=2026-11-02T08%3A10%3A00", "runId=abc&opening=2026-02-30T08%3A10%3A00Z",
      "runId=abc&opening=2026-11-02T24%3A00%3A00Z", "runId=abc&opening=2026-11-02T08%3A10%3A00%2B25%3A00",
    ]) {
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
  it("answers named openings with the exact P&L read from every observation", async () => {
    // Ten-minute syncs, each £1 up on £1,000 contributed; the 5D chart keeps one reading per 30 minutes.
    const intradayNav = Array.from({ length: 37 }, (_, step) => {
      const value = 1000 + step;
      return { date: new Date(Date.parse("2026-10-29T00:00:00Z") + step * 600_000).toISOString(), intraday: true,
        valuationSource: "broker", flowStatus: "verified", invest: value, isa: 0, total: value, household: value, cfd: null,
        investNetContributionsGbp: 1000, isaNetContributionsGbp: 0, totalNetContributionsGbp: 1000,
        investTwr: null, isaTwr: null, totalTwr: null, investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null };
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      runId: "opening-revision", brokerAsOf: "2026-10-29T06:00:00Z", dataRevision: "opening-revision", nav: [], intradayNav,
    })));
    const params = new URLSearchParams({ runId: "opening-revision", range: "1W", scope: "total" });
    params.append("opening", "2026-10-29T00:10:00Z");
    params.append("opening", "2026-10-29T00:12:00Z");
    const chart = await (await GET(new Request(`http://localhost/?${params}`))).json();
    expect(chart.history.points.map((point: { date: string }) => point.date)).not.toContain("2026-10-29T00:10:00.000Z");
    // 00:10 was thinned off the chart but is still read exactly; nothing was taken within a sync of 00:12.
    expect(chart.openings).toEqual({ "2026-10-29T00:10:00Z": 1, "2026-10-29T00:12:00Z": null });
    const plain = await (await GET(new Request("http://localhost/?runId=opening-revision&range=1W&scope=total"))).json();
    expect(plain).not.toHaveProperty("openings");
    // The same 00:10 sync, named with explicit offsets either side of UTC.
    const offsets = new URLSearchParams({ runId: "opening-revision", range: "1W", scope: "total" });
    offsets.append("opening", "2026-10-29T01:10:00+01:00");
    offsets.append("opening", "2026-10-28T19:10:00-05:00");
    expect((await (await GET(new Request(`http://localhost/?${offsets}`))).json()).openings)
      .toEqual({ "2026-10-29T01:10:00+01:00": 1, "2026-10-28T19:10:00-05:00": 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
