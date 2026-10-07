import { describe, expect, it } from "vitest";
import type { RefreshJob } from "@/lib/types";
import { collapseRoutineRuns } from "./job-history";

const job = (jobId: string, scope: string, status: string) => ({ jobId, scope, status }) as unknown as RefreshJob;

describe("collapseRoutineRuns", () => {
  it("keeps attention runs and only the latest success per scope", () => {
    const rows = collapseRoutineRuns([
      job("6", "live", "succeeded"),
      job("5", "performance", "succeeded"),
      job("4", "live", "failed"),
      job("3", "live", "succeeded"),
      job("2", "performance", "succeeded"),
      job("1", "live", "succeeded"),
    ]);
    expect(rows.map((row) => [row.job.jobId, row.repeats])).toEqual([
      ["6", 2],
      ["5", 1],
      ["4", 0],
    ]);
  });
});
