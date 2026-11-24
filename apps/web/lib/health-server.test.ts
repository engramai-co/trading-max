import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./backend", () => ({
  backendFetch: vi.fn(),
  backendUrl: vi.fn(),
}));

import { backendFetch, backendUrl } from "./backend";
import { loadHealthDetails } from "./health-server";

const fetchMock = vi.mocked(backendFetch);
const urlMock = vi.mocked(backendUrl);

describe("loadHealthDetails", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    urlMock.mockReset();
    urlMock.mockReturnValue("http://127.0.0.1:8421");
  });

  it("returns queue and outcomes independently of failed refresh and jobs probes", async () => {
    const queue = { queued: 2, running: 0, succeeded: 1, failed: 0, interrupted: 0 };
    const outcomes = { totals: { succeeded: 1 }, causes: [] };
    fetchMock.mockImplementation(async (pathname) => {
      if (pathname === "/health") return Response.json({ status: "ok", queue, artifactAgeSeconds: 432_000 });
      if (pathname === "/ready") return Response.json({ status: "ready" });
      if (pathname === "/v1/jobs/outcomes?days=7") return Response.json(outcomes);
      return new Response(null, { status: 503 });
    });

    const details = await loadHealthDetails();
    expect(details.health).toMatchObject({ queue, artifactAgeSeconds: 432_000 });
    expect(details.refresh).toBeNull();
    expect(details.jobs).toEqual([]);
    expect(details.outcomes).toEqual(outcomes);
    expect(details.errors.map(({ scope, status }) => [scope, status])).toEqual([
      ["refresh", 503], ["jobs", 503],
    ]);
  });

  it("forwards latest terminal jobs independently of the visible list", async () => {
    const terminal = [{ scope: "cfd", status: "failed", jobId: "old-cfd" }];
    fetchMock.mockImplementation(async (pathname) =>
      Response.json(pathname === "/v1/jobs?limit=12" ? { jobs: [], latestTerminalJobs: terminal } : {}),
    );
    const details = await loadHealthDetails();
    expect(details.jobs).toEqual([]);
    expect(details.latestTerminalJobs).toEqual(terminal);
  });

  it("reports a missing jobs array as an unavailable probe", async () => {
    fetchMock.mockImplementation(async () => Response.json({}));
    const details = await loadHealthDetails();
    expect(details.jobs).toEqual([]);
    expect(details.errors).toEqual([
      { scope: "jobs", status: 200, detail: "jobs returned an invalid response" },
    ]);
  });
});
