import type { DraftEvent, DraftResult, DraftReview } from "./valuation-draft";

export function newReview(result: DraftResult): DraftReview {
  const decisions: DraftReview["decisions"] = { bear: {}, base: {}, bull: {} };
  for (const p of result.proposals) decisions[p.scenario][p.field] = "unreviewed";
  return { id: result.id, decisions };
}

export async function readDraft(response: Response, update: (phase: DraftEvent["phase"]) => void) {
  if (!response.ok || !response.body) throw new Error("assistant_failed");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("assistant_interrupted");
      buffer += value;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const event: DraftEvent = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event.phase === "error") throw new Error(event.code ?? "assistant_failed");
        if (event.phase === "complete" && event.result) return event.result;
        update(event.phase);
        end = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
