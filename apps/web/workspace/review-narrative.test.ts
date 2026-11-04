import { describe, expect, it } from "vitest";
import type { AnalysisArtifact } from "@/lib/types";
import { narrativeAction, narrativeDetails } from "./review-narrative";

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

describe("the AI review's disclosure", () => {
  const zh = (text: string) => text;
  const en = (_: string, text: string) => text;
  const none = { evidence: [], nextObservations: [], counterpoints: [] };
  const said = { zh: "某句", en: "A line" };

  it("names each part it holds, in reading order", () => {
    const full = {
      evidence: [{ label: said, detail: said, metric: null, sourceRefs: [] }],
      nextObservations: [said],
      counterpoints: [said],
    };
    expect(narrativeDetails(full, zh)).toEqual(["依据", "下次决定前", "保留意见"]);
    expect(narrativeDetails(full, en)).toEqual(["Evidence", "Before the next decision", "Caveats"]);
  });

  it("leaves out the parts a review does not have", () => {
    expect(narrativeDetails({ ...none, counterpoints: [said] }, en)).toEqual(["Caveats"]);
  });

  it("has nothing to disclose when a review is only its headline and summary", () => {
    expect(narrativeDetails(none, zh)).toEqual([]);
  });
});
