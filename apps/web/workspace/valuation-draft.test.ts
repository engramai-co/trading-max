import { describe, expect, it } from "vitest";
import { newReview, readDraft, type DraftResult } from "./valuation-draft";

const result: DraftResult = { id: "draft", snapshotId: "run", family: "cash-flow", familySelection: "automatic", origins: {}, evidence: {}, proposals: [{ scenario: "base", field: "revenue_cagr",
  value: 0.2, source: "consensus-growth", category: "consensus", evidenceIds: ["growth"] }] };
const encode = (chunks: string[]) => new Response(new ReadableStream({ start(c) {
  for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
  c.close();
} }));

describe("valuation review", () => {
  it("stages nothing until the user accepts a field", () => {
    expect(newReview(result).decisions).toEqual({ bear: {}, base: { revenue_cagr: "unreviewed" }, bull: {} });
  });
  it("reads partial lines and refuses interrupted and failed drafts", async () => {
    const phases: string[] = [];
    expect(await readDraft(encode(['{"phase":"ba','sis"}\n', JSON.stringify({phase:"complete",result})+'\n']), p => phases.push(p))).toEqual(result);
    expect(phases).toEqual(["basis"]);
    await expect(readDraft(encode(['{"phase":"basis"}\n']), () => {})).rejects.toThrow("assistant_interrupted");
    await expect(readDraft(encode(['{"phase":"error","code":"assistant_busy"}\n']), () => {})).rejects.toThrow("assistant_busy");
  });
});
