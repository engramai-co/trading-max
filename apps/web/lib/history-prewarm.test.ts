import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./backend", () => ({ backendFetch: vi.fn(), backendUrl: () => "http://backend" }));
vi.mock("./history-server", () => ({ readPreparedHistory: vi.fn(async () => ({})) }));
import { backendFetch } from "./backend";
import { readPreparedHistory } from "./history-server";
import { startHistoryPrewarm } from "./history-prewarm";

const health = (latestRunId: string) => new Response(JSON.stringify({ latestRunId }));

describe("history prewarm", () => {
  beforeEach(() => vi.useFakeTimers());
  it("prepares the default views once per new run and retries after a failure", async () => {
    vi.mocked(backendFetch)
      .mockResolvedValueOnce(health("run-1"))
      .mockResolvedValueOnce(health("run-1"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(health("run-2"));
    startHistoryPrewarm(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(readPreparedHistory).mock.calls.map(([selection]) => selection)).toEqual([
      { runId: "run-1", range: "3M", scope: "total" },
      { runId: "run-1", range: "1D", scope: "total" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readPreparedHistory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readPreparedHistory).toHaveBeenCalledTimes(4);
    expect(vi.mocked(readPreparedHistory).mock.calls.at(-1)![0]).toMatchObject({ runId: "run-2", range: "1D" });
  });
});

