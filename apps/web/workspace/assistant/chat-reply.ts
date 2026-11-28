import type { UIMessage } from "ai";
import type { Locale } from "@/components/locale-provider";
import { object, objects, str } from "../data";
import { completedEvidence, evidenceArguments, readableDates, sourceLabel, verifiedCitationLine, type Evidence } from "./evidence";
import { researchFigure } from "./research-figures";
import type { ReplyMove } from "./reply-move";
import { calendarObservation, inferenceText, renderToolField } from "./figures";
import { reviewFieldLocation, reviewReturnReply } from "./review-figures";

type ReplySubject = { subject: string; day?: string };
type VerifiedLine = { text: string; evidence: Evidence | null; move?: ReplyMove; datedSubject?: ReplySubject };

export function replyText(line: VerifiedLine, locale: Locale, timeZone: string, t: (zh: string, en: string) => string) {
  return readableDates(line.text, locale, timeZone) + " " + sourceLabel(line.evidence, t);
}

function replyLines(message: UIMessage) {
  return message.parts.filter(p => p.type === "text").map(p => p.text).join("")
    .split(/\n+/).map(line => line.trim()).filter(Boolean);
}

/** Resolve the whole reply before displaying or announcing any part of it. */
export function verifiedLines(message: UIMessage, locale: Locale = "en", timeZone = "Europe/London") {
  const lines = replyLines(message);
  if (lines.length < 2 || lines.length > 4) return [];
  const references = completedEvidence(message);
  const result: VerifiedLine[] = [];
  for (const line of lines) {
    const verified = verifyLine(line, references, locale, timeZone, result.at(-1)?.datedSubject);
    if (!verified) return [];
    result.push(verified);
  }
  return result;
}

/** An interrupted reply can keep independently verified observations. */
export function verifiedInterruptedLines(message: UIMessage, locale: Locale = "en", timeZone = "Europe/London") {
  const references = completedEvidence(message);
  return replyLines(message).slice(0, 4).flatMap(line => {
    const verified = verifyLine(line, references, locale, timeZone);
    return verified?.evidence ? [verified] : [];
  });
}

function verifyLine(
  line: string,
  references: ReturnType<typeof completedEvidence>,
  locale: Locale,
  timeZone: string,
  previous?: ReplySubject,
): VerifiedLine | null {
  const match = /^\{\{([^{}\s]{1,160})\}\}\s+\[(inference|ev_[a-zA-Z0-9_-]+)\]$/.exec(line);
  if (!match) return null;
  const [, pointer, id] = match;
  if (id === "inference") {
    const text = inferenceText(pointer, locale);
    return text ? { text, evidence: null } : null;
  }
  const source = references.get(id);
  if (!source) return null;
  if (["upcoming_events","news_and_events"].includes(source.ref.tool) && pointer.startsWith("/data/items/")) {
    const observation = calendarObservation(source.ref, source.output, pointer, locale, timeZone);
    return observation && verifiedCitationLine(observation, source.output, pointer);
  }
  const research = researchFigure(source.ref, source.output, pointer, locale, timeZone);
  const sentence = research?.reply;
  const datedSubject = sentence?.subject ? {day: sentence.day, subject: sentence.subject} : undefined;
  const sameSubjectAndDay = datedSubject?.day && datedSubject.day === previous?.day && datedSubject.subject === previous.subject;
  const reply = (sameSubjectAndDay ? sentence?.sameDayText : undefined) ?? sentence?.text;
  // Keep the same verification, coverage suffix and source even when chat uses a sentence.
  const text = renderToolField(source.ref.tool, source.output, pointer, locale, timeZone,
    research && reply ? {...research, text: reply} : research);
  if (!text) return null;
  let evidence = research?.evidence ?? source.ref;
  const review = reviewFieldLocation(evidence.tool, source.output, pointer);
  if (review) {
    evidence = {...evidence, arguments:evidenceArguments({...evidence.arguments, ...review, snapshotId:str(source.output.snapshot_id) || evidence.arguments?.snapshotId}, source.output)};
  } else if (evidence.tool === "period_performance") {
    const data = object(source.output.data);
    evidence = {...evidence, arguments:{...evidence.arguments, range:str(data.range) || str(evidence.arguments?.range),
      start:str(data.window_start), end:str(data.window_end)}};
  } else if (evidence.tool === "compare_benchmarks") {
    const data = object(source.output.data);
    evidence = {...evidence, arguments:evidenceArguments({...evidence.arguments, start:str(data.start), end:str(data.end), snapshotId:str(source.output.snapshot_id) || evidence.arguments?.snapshotId}, source.output)};
  }
  if (["list_holdings","position_detail","lookthrough_exposure","dated_exposure","selected_exposure","selected_daily","selected_fx","sector_headline","selected_money","daily_returns","holding_fx_split","exposure_benchmark","market_sector","global_map","update_issue"].includes(evidence.tool)) {
    evidence = {...evidence,arguments:{...evidence.arguments,metric:pointer}};
  }
  if (evidence.tool === "exposure_benchmark") {
    const data = object(source.output.data);
    evidence = {...evidence, arguments:{...evidence.arguments,benchmarkSource:str(data.source),benchmarkAsOf:str(data.as_of),benchmarkObservation:str(data.observation)}};
  }
  if (["daily_returns","selected_daily"].includes(evidence.tool) && pointer.startsWith("/data/window_benchmarks/")) {
    const data = object(source.output.data);
    evidence = {...evidence, arguments:{...evidence.arguments,benchmark_basis:str(data.benchmark_basis),benchmark_currency:str(data.benchmark_currency)}};
  }
  if (evidence.tool === "news_and_events" || evidence.tool === "sector_headline") {
    const match = /^\/data\/items\/(\d+)\/title_en$/.exec(pointer);
    const item = match && objects(object(source.output.data).items)[Number(match[1])];
    if (item) evidence={...evidence,source:"publisher",publisher:str(item.publisher),arguments:{...evidence.arguments,url:str(item.source_url)}};
  }
  const reviewReply = evidence.tool === "decision_timing_and_habits" ? reviewReturnReply(source.output, pointer, locale) : undefined;
  const move = sentence?.move ?? reviewReply?.move;
  const previewText = sentence ? renderToolField(source.ref.tool, source.output, pointer, locale, timeZone, research) : null;
  return {
    ...verifiedCitationLine({text: reviewReply?.text ?? text, evidence}, source.output, pointer, previewText ?? reviewReply?.text ?? text),
    ...(move && {move}),
    ...(datedSubject && {datedSubject}),
  };
}
