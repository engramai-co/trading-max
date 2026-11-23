import { describe, expect, it, vi } from "vitest";
import type { DraftResult } from "./valuation-draft";
import { newReview, readDraft } from "./valuation-draft-stream";

const result: DraftResult = { id: "draft", snapshotId: "run", family: "cash-flow", familySelection: "automatic", deskReadings:{base:{value:150,upside:0.5}}, origins: {}, evidence: {}, proposals: [{ scenario: "base", field: "revenue_cagr",
  value: 0.2, source: "consensus-growth", category: "consensus", evidenceIds: ["growth"] }] };
const encode = (chunks: string[]) => new Response(new ReadableStream({ start(c) {
  for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
  c.close();
} }));
const openStream = (chunks: string[], init?: ResponseInit) => {
  const onCancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
    },
    cancel: onCancel,
  }), init);
  return { response, onCancel };
};

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
  it("cancels the source stream on terminal events, malformed JSON, and non-OK responses without closing", async () => {
    const complete = openStream([JSON.stringify({ phase: "complete", result }) + "\n"]);
    await expect(readDraft(complete.response, () => {})).resolves.toEqual(result);
    expect(complete.onCancel).toHaveBeenCalledTimes(1);

    const failed = openStream(['{"phase":"error","code":"assistant_busy"}\n']);
    await expect(readDraft(failed.response, () => {})).rejects.toThrow("assistant_busy");
    expect(failed.onCancel).toHaveBeenCalledTimes(1);

    const malformed = openStream(['{"phase":\n']);
    await expect(readDraft(malformed.response, () => {})).rejects.toThrow(SyntaxError);
    expect(malformed.onCancel).toHaveBeenCalledTimes(1);

    const nonOk = openStream([], { status: 503 });
    await expect(readDraft(nonOk.response, () => {})).rejects.toThrow("assistant_failed");
    expect(nonOk.onCancel).toHaveBeenCalledTimes(1);
  });
});
