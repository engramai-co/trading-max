import { describe, expect, it } from "vitest";
import type { AnalysisArtifact } from "@/lib/types";
import { narrativeAction } from "./review-narrative";

const stored = {} as AnalysisArtifact;

describe("the AI review's action", () => {
  it("offers nothing that could replace a review until the lookup answers", () => {
    expect(narrativeAction({ isPending: true, isError: false, data: undefined })).toBe("wait");
  });

  it("offers a retry, not a first review, when the lookup failed", () => {
    expect(narrativeAction({ isPending: false, isError: true, data: undefined })).toBe("retry");
  });

  it("offers a first review only once the lookup found none", () => {
    expect(narrativeAction({ isPending: false, isError: false, data: null })).toBe("generate");
  });

  it("asks before replacing a stored review, even after a later lookup failed", () => {
    expect(narrativeAction({ isPending: false, isError: false, data: stored })).toBe("regenerate");
    expect(narrativeAction({ isPending: false, isError: true, data: stored })).toBe("regenerate");
  });
});
