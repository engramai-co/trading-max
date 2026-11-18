import type { UIMessage } from "ai";
import type { Locale } from "@/components/locale-provider";
import { object, str } from "../data";
import { completedEvidence, type Evidence } from "./evidence";
import { inferenceText, renderToolField } from "./figures";
import { reviewFieldLocation } from "./review-figures";

/** Resolve the whole reply before displaying or announcing any part of it. */
export function verifiedLines(message: UIMessage, locale: Locale = "en", timeZone = "Europe/London") {
  const references = completedEvidence(message);
  const raw = message.parts.filter(p => p.type === "text").map(p => p.text).join("").trim();
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 4) return [];
  const result: { text: string; evidence: Evidence | null }[] = [];
  for (const line of lines) {
    const match = /^\{\{([^{}\s]{1,160})\}\}\s+\[(inference|ev_[a-zA-Z0-9_-]+)\]$/.exec(line);
    if (!match) return [];
    const [, pointer, id] = match;
    const source = references.get(id);
    if (id === "inference") {
      const text = inferenceText(pointer, locale);
      if (!text) return [];
      result.push({text, evidence:null});
    } else {
      if (!source) return [];
      const text = renderToolField(source.ref.tool, source.output, pointer, locale, timeZone);
      if (!text) return [];
      let evidence = source.ref;
      const review = reviewFieldLocation(evidence.tool, source.output, pointer);
      if (review) {
        evidence = {...evidence, arguments:{...evidence.arguments, ...review}};
      } else if (evidence.tool === "period_performance" && pointer === "/data/period_pnl_gbp") {
        const data = object(source.output.data);
        evidence = {...evidence, arguments:{...evidence.arguments, metric:"period_pnl_gbp",
          start:str(data.window_start), end:str(data.window_end), snapshotId:str(source.output.snapshot_id)}};
      } else if (evidence.tool === "compare_benchmarks") {
        const data = object(source.output.data);
        evidence = {...evidence, arguments:{...evidence.arguments, start:str(data.start), end:str(data.end)}};
      }
      result.push({text, evidence});
    }
  }
  return result;
}
