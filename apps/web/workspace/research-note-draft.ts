import type { components } from "@/lib/api-schema";

type Note = components["schemas"]["ResearchNote"];
type NoteInput = components["schemas"]["ResearchNoteInput"];

export type NoteDraft = {
  baseRevision: number | null;
  title: string;
  thesis: string;
  invalidation: string;
  urls: string;
  modelId: string | null;
  reviewDate: string | null;
};

export type NoteDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const DRAFT_PREFIX = "tm-research-note-draft:";
const memoryDrafts = new Map<string, string>();

export function emptyNoteDraft(): NoteDraft {
  return {
    baseRevision: null,
    title: "",
    thesis: "",
    invalidation: "",
    urls: "",
    modelId: null,
    reviewDate: null,
  };
}

export function noteBaselineDraft(note?: Note): NoteDraft {
  const latest = note?.revisions.at(-1);
  if (!latest) return emptyNoteDraft();
  const { content } = latest;
  return {
    baseRevision: latest.revision,
    title: content.title ?? "",
    thesis: content.thesis ?? "",
    invalidation: content.invalidation ?? "",
    urls: (content.evidenceUrls ?? []).join("\n"),
    modelId: content.modelId ?? null,
    reviewDate: content.reviewDate ?? null,
  };
}

export function isNoteDraftDirty(draft: NoteDraft, baseline: NoteDraft): boolean {
  return (
    draft.title !== baseline.title ||
    draft.thesis !== baseline.thesis ||
    draft.invalidation !== baseline.invalidation ||
    draft.urls !== baseline.urls ||
    (draft.modelId ?? null) !== (baseline.modelId ?? null) ||
    (draft.reviewDate || null) !== (baseline.reviewDate || null)
  );
}

export function noteDraftKey(ticker: string, noteId?: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(ticker.trim().toUpperCase())}:${encodeURIComponent(noteId || "new")}`;
}

function browserStorage(): NoteDraftStorage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function readStored(key: string, storage?: NoteDraftStorage): string | null {
  if (storage) return storage.getItem(key);
  if (memoryDrafts.has(key)) return memoryDrafts.get(key) ?? null;
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string, storage?: NoteDraftStorage): void {
  if (storage) {
    storage.setItem(key, value);
    return;
  }
  try {
    const target = browserStorage();
    if (target) {
      target.setItem(key, value);
      memoryDrafts.delete(key);
      return;
    }
  } catch {
    /* Storage disabled or full; fall back to in-memory session drafts. */
  }
  memoryDrafts.set(key, value);
}

function removeStored(key: string, storage?: NoteDraftStorage): void {
  if (storage) {
    storage.removeItem(key);
    return;
  }
  memoryDrafts.delete(key);
  try {
    browserStorage()?.removeItem(key);
  } catch {
    /* Storage disabled. */
  }
}

function parseNoteDraft(raw: string | null, noteId?: string): NoteDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const baseRevision = record.baseRevision;
    if (
      typeof record.title !== "string" ||
      typeof record.thesis !== "string" ||
      typeof record.invalidation !== "string" ||
      typeof record.urls !== "string"
    ) {
      return null;
    }
    if (noteId && (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1)) {
      return null;
    }
    const modelId = record.modelId === null || typeof record.modelId === "string" ? record.modelId : null;
    const reviewDate = record.reviewDate === null || typeof record.reviewDate === "string" ? record.reviewDate : null;
    return {
      baseRevision: typeof baseRevision === "number" ? baseRevision : null,
      title: record.title,
      thesis: record.thesis,
      invalidation: record.invalidation,
      urls: record.urls,
      modelId,
      reviewDate: reviewDate || null,
    };
  } catch {
    return null;
  }
}

export function loadNoteDraft(ticker: string, noteId?: string, storage?: NoteDraftStorage): NoteDraft | null {
  return parseNoteDraft(readStored(noteDraftKey(ticker, noteId), storage), noteId);
}

export function saveNoteDraft(
  ticker: string,
  noteId: string | undefined,
  draft: NoteDraft,
  baseline: NoteDraft,
  storage?: NoteDraftStorage,
): boolean {
  const key = noteDraftKey(ticker, noteId);
  if (!isNoteDraftDirty(draft, baseline)) {
    removeStored(key, storage);
    return false;
  }
  writeStored(key, JSON.stringify(draft), storage);
  return true;
}

export function clearNoteDraft(ticker: string, noteId?: string, storage?: NoteDraftStorage): void {
  removeStored(noteDraftKey(ticker, noteId), storage);
}

export function openNoteDraft(
  ticker: string,
  note?: Note,
  storage?: NoteDraftStorage,
): NoteDraft {
  const baseline = noteBaselineDraft(note);
  const saved = loadNoteDraft(ticker, note?.id, storage);
  if (saved && isNoteDraftDirty(saved, baseline)) return saved;
  if (saved) clearNoteDraft(ticker, note?.id, storage);
  return baseline;
}

export function toNoteInput(
  draft: NoteDraft,
  note?: Note,
  reviewDateOverride?: FormDataEntryValue | null,
): NoteInput {
  const latest = note?.revisions.at(-1);
  const reviewDate =
    typeof reviewDateOverride === "string"
      ? reviewDateOverride || null
      : draft.reviewDate || null;
  return {
    archived: latest ? latest.content.archived : false,
    ...(latest ? { expectedRevision: draft.baseRevision } : {}),
    title: draft.title.trim(),
    thesis: draft.thesis,
    invalidation: draft.invalidation,
    evidenceUrls: draft.urls
      .split(/\n/)
      .map((v) => v.trim())
      .filter(Boolean),
    modelId: draft.modelId,
    reviewDate,
  };
}
