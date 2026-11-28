import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBackend = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendFetch: fetchBackend }));

import { GET } from "@/app/api/backend/health/task/route";

const request = new Request("http://localhost/api/backend/health/task?job=synthetic-task");
const task = { jobId: "synthetic-task", trigger: "on_demand", stages: [] };

describe("Data Status task proxy", () => {
  beforeEach(() => {
    fetchBackend.mockReset();
  });

  it("keeps a stage-less private job hidden when the old service has no history endpoint", async () => {
    fetchBackend.mockImplementation(async (path) => path === "/v1/jobs/synthetic-task"
      ? Response.json(task)
      : Response.json({ detail: "Not Found" }, { status: 404 }));

    const response = await GET(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "Update task unavailable" });
    expect(fetchBackend).toHaveBeenCalledExactlyOnceWith("/v1/job-history/synthetic-task", { signal: request.signal, redirect: "error" });
  });

  it("passes through a public task from the history endpoint", async () => {
    fetchBackend.mockResolvedValue(Response.json(task));
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(task);
    expect(fetchBackend).toHaveBeenCalledExactlyOnceWith("/v1/job-history/synthetic-task", { signal: request.signal, redirect: "error" });
  });

  it("maps a history-specific not-found response to a safe not-found response", async () => {
    fetchBackend.mockResolvedValue(Response.json({ detail: { code: "job_history_not_found" } }, { status: 404 }));
    const response = await GET(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Update task not found" });
  });
});
