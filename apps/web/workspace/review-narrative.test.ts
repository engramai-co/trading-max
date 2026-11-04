import { describe, expect, it } from "vitest";
import type { AnalysisArtifact } from "@/lib/types";
import { narrativeAction } from "./review-narrative";

const stored = {} as AnalysisArtifact;
const lookup = { isPending: false, isError: false, isFetching: false };

describe("the AI review's action", () => {
  it("offers nothing that could replace a review until the lookup answers", () => {
    expect(narrativeAction({ ...lookup, isPending: true, isFetching: true, data: undefined })).toBe("wait");
  });

  it("offers a retry, not a first review, when the lookup failed", () => {
    expect(narrativeAction({ ...lookup, isError: true, data: undefined })).toBe("retry");
  });

  it("offers a first review only once a settled lookup found none", () => {
    expect(narrativeAction({ ...lookup, data: null })).toBe("generate");
  });

  it("waits while a cached none is looked up again, as right after a review was written", () => {
    expect(narrativeAction({ ...lookup, isFetching: true, data: null })).toBe("wait");
  });

  it("waits while a run is writing the first review", () => {
    expect(narrativeAction({ ...lookup, data: null }, true)).toBe("wait");
  });

  it("asks before replacing a stored review, even after a later lookup failed", () => {
    expect(narrativeAction({ ...lookup, data: stored })).toBe("regenerate");
    expect(narrativeAction({ ...lookup, isError: true, data: stored })).toBe("regenerate");
  });
});
