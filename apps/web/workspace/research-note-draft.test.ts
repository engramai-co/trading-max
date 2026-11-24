import { describe, expect, it } from "vitest";
import type { components } from "@/lib/api-schema";
import {
  clearNoteDraft,
  emptyNoteDraft,
  isNoteDraftDirty,
  loadNoteDraft,
  noteBaselineDraft,
  noteDraftKey,
  openNoteDraft,
  saveNoteDraft,
  toNoteInput,
  type NoteDraftStorage,
} from "./research-note-draft";

type Note = components["schemas"]["ResearchNote"];

function memoryStore(): NoteDraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const existingNote: Note = {
  id: "note-1",
  ticker: "SYNT",
  revisions: [
    {
      revision: 2,
      savedAt: "2026-11-04T12:00:00Z",
      content: {
        title: "Saved title",
        archived: false,
        thesis: "Saved thesis",
        invalidation: "Margin drops below 10%",
        evidenceUrls: ["https://example.com/a", "https://example.com/b"],
        reviewDate: "2027-01-15",
        modelId: "model-1",
      },
    },
  ],
};

describe("research note drafts", () => {
  it("tracks dirtiness against the blank or latest saved baseline", () => {
    const empty = emptyNoteDraft();
    expect(isNoteDraftDirty(empty, empty)).toBe(false);
    expect(isNoteDraftDirty({ ...empty, title: "Draft" }, empty)).toBe(true);
    expect(isNoteDraftDirty({ ...empty, thesis: "Evidence" }, empty)).toBe(true);

    const baseline = noteBaselineDraft(existingNote);
    expect(baseline).toEqual({
      baseRevision: 2,
      title: "Saved title",
      thesis: "Saved thesis",
      invalidation: "Margin drops below 10%",
      urls: "https://example.com/a\nhttps://example.com/b",
      modelId: "model-1",
      reviewDate: "2027-01-15",
    });
    expect(isNoteDraftDirty({ ...baseline }, baseline)).toBe(false);
    expect(isNoteDraftDirty({ ...baseline, thesis: "Updated thesis" }, baseline)).toBe(true);
    expect(isNoteDraftDirty({ ...baseline, reviewDate: null }, baseline)).toBe(true);
  });

  it("keeps the original base revision when an existing note has changed since dismissal", () => {
    const storage = memoryStore();
    const baseline = noteBaselineDraft(existingNote);
    saveNoteDraft("SYNT", existingNote.id, { ...baseline, thesis: "Edited thesis" }, baseline, storage);
    const latestNote = {
      ...existingNote,
      revisions: [...existingNote.revisions, {
        revision: 3,
        savedAt: "2026-11-04T13:00:00Z",
        content: { ...existingNote.revisions[0].content, title: "Remote title" },
      }],
    };

    const draft = openNoteDraft("SYNT", latestNote, storage);
    expect(toNoteInput(draft, latestNote)).toMatchObject({ expectedRevision: 2, thesis: "Edited thesis" });

    clearNoteDraft("SYNT", latestNote.id, storage);
    const reloaded = openNoteDraft("SYNT", latestNote, storage);
    expect(loadNoteDraft("SYNT", latestNote.id, storage)).toBeNull();
    expect(toNoteInput(reloaded, latestNote)).toMatchObject({ expectedRevision: 3, title: "Remote title" });
  });

  it("isolates session drafts per ticker and note ID, restores on reopen, and clears on revert or discard", () => {
    const storage = memoryStore();
    const blank = emptyNoteDraft();

    expect(saveNoteDraft("synt", undefined, { ...blank, title: "SYNT draft", thesis: "SYNT thesis" }, blank, storage)).toBe(true);
    expect(saveNoteDraft("AAPL", undefined, { ...blank, title: "AAPL draft" }, blank, storage)).toBe(true);
    expect(saveNoteDraft("SYNT", existingNote.id, { ...noteBaselineDraft(existingNote), thesis: "Edited thesis" }, noteBaselineDraft(existingNote), storage)).toBe(true);

    expect(openNoteDraft("SYNT", undefined, storage)).toEqual({
      ...blank, title: "SYNT draft", thesis: "SYNT thesis",
    });
    expect(openNoteDraft("AAPL", undefined, storage).title).toBe("AAPL draft");
    expect(openNoteDraft("MSFT", undefined, storage)).toEqual(blank);
    expect(openNoteDraft("SYNT", existingNote, storage)).toEqual({
      ...noteBaselineDraft(existingNote), thesis: "Edited thesis",
    });

    // Reverting back to the baseline removes the stored draft.
    expect(saveNoteDraft("SYNT", undefined, blank, blank, storage)).toBe(false);
    expect(loadNoteDraft("SYNT", undefined, storage)).toBeNull();

    // Explicit discard clears only the targeted draft.
    clearNoteDraft("SYNT", existingNote.id, storage);
    expect(loadNoteDraft("SYNT", existingNote.id, storage)).toBeNull();
    expect(openNoteDraft("SYNT", existingNote, storage)).toEqual(noteBaselineDraft(existingNote));
    expect(openNoteDraft("AAPL", undefined, storage).title).toBe("AAPL draft");
  });

  it("ignores corrupt storage entries and falls back to in-memory session storage", () => {
    const storage = memoryStore();
    storage.setItem(noteDraftKey("SYNT"), "{not-json");
    expect(loadNoteDraft("SYNT", undefined, storage)).toBeNull();

    storage.setItem(noteDraftKey("SYNT"), JSON.stringify({ title: 123 }));
    expect(loadNoteDraft("SYNT", undefined, storage)).toBeNull();

    // In Node without sessionStorage, drafts still persist for the in-memory session.
    const blank = emptyNoteDraft();
    expect(saveNoteDraft("SYNT", undefined, { ...blank, title: "Fallback draft" }, blank)).toBe(true);
    expect(openNoteDraft("SYNT").title).toBe("Fallback draft");
    clearNoteDraft("SYNT");
    expect(openNoteDraft("SYNT")).toEqual(blank);
  });

  it("builds API inputs preserving trimmed fields, evidence URLs, and expectedRevision", () => {
    expect(
      toNoteInput({
        baseRevision: null,
        title: "  New note  ",
        thesis: "Thesis text",
        invalidation: "Check",
        urls: " https://example.com/1 \n\n https://example.com/2 ",
        modelId: "m1",
        reviewDate: null,
      }, undefined, "2027-03-01"),
    ).toEqual({
      archived: false,
      title: "New note",
      thesis: "Thesis text",
      invalidation: "Check",
      evidenceUrls: ["https://example.com/1", "https://example.com/2"],
      modelId: "m1",
      reviewDate: "2027-03-01",
    });

    expect(
      toNoteInput({ ...noteBaselineDraft(existingNote), title: "Updated" }, existingNote, ""),
    ).toEqual({
      archived: false,
      expectedRevision: 2,
      title: "Updated",
      thesis: "Saved thesis",
      invalidation: "Margin drops below 10%",
      evidenceUrls: ["https://example.com/a", "https://example.com/b"],
      modelId: "model-1",
      reviewDate: null,
    });
  });
});
