"use client";

import { useBuildNavigationGuard } from "@/ui/publication-provider";
import type { components } from "@/lib/api-schema";
import type { ResearchLensSnapshot } from "@/lib/types";
import {
  Button,
  Drawer,
  Select,
  Textarea,
  TextInput,
} from "@mantine/core";
import { skipToken, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { quoteUnit, quoteValue } from "./financial-values";
import { isImeComposing } from "./shortcut-platform";
import {
  clearNoteDraft,
  emptyNoteDraft,
  isNoteDraftDirty,
  noteBaselineDraft,
  openNoteDraft,
  saveNoteDraft,
  toNoteInput,
  type NoteDraft,
} from "./research-note-draft";
import { useLocale } from "@/components/locale-provider";
import { formatDateTime } from "@/ui/formatters";
import { ApiError, api, compact, jsonRequest, number, percent, safeUrl } from "@/workspace/data";
import { ValuationFloorNote } from "./valuation-floor-note";
import { EvidenceTable } from "./evidence-table";
import {
  Empty,
  Panel,
  Pending,
  QueryError,
  Segments,
  useCopy,
} from "./foundation";
import { ResearchDocuments } from "./research-evidence";
import { useRouteState } from "./route-state";
import { noticeKinds, useEvidenceNotice } from "./evidence-notices";
import Link from "./link";

type Journal = components["schemas"]["ResearchJournal"];
type Note = components["schemas"]["ResearchNote"];
type NoteInput = components["schemas"]["ResearchNoteInput"];
type NoteEditor = { note?: Note; draft: NoteDraft };
type NoteError = "conflict" | "resolution" | "save";
type NoteErrors = ReadonlyMap<string | undefined, NoteError>;
type NoteChange =
  | { action: "save" | "archive"; id?: string; content: NoteInput }
  | { action: "keep"; id: string; content: NoteInput }
  | { action: "load"; id: string };

export function ResearchNotebook({ data, fund = false }: { data: ResearchLensSnapshot; fund?: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const { params, update } = useRouteState("push");
  const section = fund ? "notes" : params.get("notebook") ?? "notes";
  const [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<NoteEditor | null>(null);
  useBuildNavigationGuard(Boolean(editor));
  const editorRef = useRef<NoteEditor | null>(null);
  const newNoteButton = useRef<HTMLButtonElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [history, setHistory] = useState<Note | null>(null);
  const draft = editor?.draft ?? emptyNoteDraft();
  const dirty = Boolean(editor) && isNoteDraftDirty(draft, noteBaselineDraft(editor?.note));
  const showEditor = (next: NoteEditor | null) => {
    editorRef.current = next;
    setEditor(next);
  };
  const journalKey = ["research-journal", data.ticker];
  const journalPath = `/research/${encodeURIComponent(data.ticker)}/journal`;
  const mutationKey = ["research-note-change", data.ticker];
  const errorKey = ["research-note-errors", data.ticker];
  const { data: errors } = useQuery<NoteErrors>({ queryKey: errorKey, queryFn: skipToken, gcTime: Infinity });
  const editorError = editor && errors?.get(editor.note?.id);
  const createError = errors?.get(undefined);
  const conflict = editorError === "conflict" || editorError === "resolution";
  const noteErrorText = (error: NoteError) => {
    if (error === "conflict") return t("笔记已有更新。", "This note has changed.");
    if (error === "resolution") return t("无法处理冲突，请重试。", "Could not resolve the conflict. Try again.");
    return t("无法保存笔记。", "Could not save the note.");
  };
  const setNoteError = (id: string | undefined, error?: NoteError) => {
    client.setQueryData<NoteErrors>(errorKey, (previous) => {
      if (!error && !previous?.has(id)) return previous;
      const next = new Map(previous);
      if (error) next.set(id, error);
      else next.delete(id);
      return next;
    });
  };
  const query = useQuery({
    queryKey: journalKey,
    queryFn: ({ signal }) => api<Journal>(journalPath, { signal }),
    enabled: section === "notes" || section === "models",
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationKey,
    mutationFn: async (change: NoteChange) => {
      const { action, id } = change;
      let content = "content" in change ? change.content : undefined;
      if (action === "load" || action === "keep") {
        const journal = await api<Journal>(journalPath);
        const note = journal.notes?.find((item) => item.id === id);
        const latest = note?.revisions.at(-1);
        if (!note || !latest) throw new Error("Research note is unavailable");
        if (action === "load") return note;
        content = { ...change.content, archived: latest.content.archived, expectedRevision: latest.revision };
      }
      await api<Journal>(
        id ? `${journalPath}/${encodeURIComponent(id)}` : journalPath,
        jsonRequest(id ? "PUT" : "POST", content),
      );
    },
    onSuccess: async (_note, { id, action }) => {
      if (action !== "archive") {
        clearNoteDraft(data.ticker, id);
        setNoteError(id);
      }
      // Refetch after each write so overlapping saves of different notes cannot
      // replace the journal with an older response.
      await client.invalidateQueries({ queryKey: journalKey });
    },
    onError: (error, { id, action }) => {
      if (action === "archive") return;
      const conflict = error instanceof ApiError &&
        error.status === 409 && error.message === "research-note-revision-conflict";
      setNoteError(id, conflict ? "conflict" : action === "save" ? "save" : "resolution");
    },
  });
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: ({ state }) => state.variables as NoteChange,
  });
  const editingAction = editor && pending.find(({ id }) => id === editor.note?.id)?.action;
  const readOnly = Boolean(editingAction);
  const noteBusy = (id?: string) => client.isMutating({
    mutationKey,
    predicate: ({ state }) => (state.variables as NoteChange).id === id,
  }) > 0;
  const changeNote = (change: NoteChange) => {
    if (!noteBusy(change.id)) save.mutate(change);
  };
  const applyEditorResult = useEffectEvent((change: NoteChange, note?: Note) => {
    const current = editorRef.current;
    if (!current || current.note?.id !== change.id || change.action === "archive") return;
    showEditor(note ? { note, draft: noteBaselineDraft(note) } : null);
  });
  useEffect(() => client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const key = event.mutation.options.mutationKey;
    if (key?.[0] !== "research-note-change" || key[1] !== data.ticker) return;
    const change = event.mutation.state.variables as NoteChange;
    applyEditorResult(change, event.action.data as Note | undefined);
  }), [client, data.ticker]);
  const edit = (note?: Note, trigger?: HTMLElement | null) => {
    const draft = openNoteDraft(data.ticker, note);
    returnFocusTo.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    showEditor({ note, draft });
  };
  const updateDraft = (patch: Partial<NoteDraft>) => {
    const current = editorRef.current;
    if (!current || noteBusy(current.note?.id)) return;
    const id = current.note?.id;
    const draft = { ...current.draft, ...patch };
    saveNoteDraft(data.ticker, id, draft, noteBaselineDraft(current.note));
    showEditor({ ...current, draft });
  };
  const dismissEditor = () => showEditor(null);
  const discardEditor = () => {
    const current = editorRef.current;
    if (!current || noteBusy(current.note?.id)) return;
    clearNoteDraft(data.ticker, current.note?.id);
    setNoteError(current.note?.id);
    showEditor(null);
  };
  const resolveConflict = (action: "load" | "keep") => {
    const current = editorRef.current;
    if (!current?.note) return;
    const id = current.note.id;
    changeNote(action === "load"
      ? { action, id }
      : { action, id, content: toNoteInput(current.draft, current.note) });
  };
  const onEscapeDismiss = useEffectEvent(dismissEditor);
  const opened = Boolean(editor);
  useEffect(() => {
    if (!opened) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-mantine-stop-propagation='true']")) return;
      const dialog = target?.closest('[role="dialog"]');
      if (dialog && !dialog.closest("[data-note-editor='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      onEscapeDismiss();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [opened]);
  const notes = (query.data?.notes ?? [])
    .filter((n) => Boolean(n.revisions.at(-1)?.content.archived) === archived)
    .slice()
    .reverse();
  return (
    <>
      {!fund && <Segments
        label={t("研究记录内容", "Research record contents")}
        value={section}
        onChange={(v) => update({ notebook: v })}
        options={[
          { value: "notes", label: t("研究笔记", "Notes") },
          { value: "models", label: t("模型版本", "Model versions") },
          { value: "filings", label: t("公司披露", "Disclosures") },
          { value: "news", label: t("新闻", "News") },
        ]}
      />}
      {section === "filings" || section === "news" ? (
        <ResearchDocuments data={data} news={section === "news"} />
      ) : query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : section === "models" ? (
        <ModelVersions journal={query.data} />
      ) : (
        <Panel>
          {/* The 研究笔记 segment names this list; the heading stays for assistive technology. */}
          <h2 className="sr-only">{t("研究笔记", "Research notes")}</h2>
          <div className="mx-notes-bar">
            {!notes.length && (
              <p>
                {archived
                  ? t("没有归档笔记", "No archived notes")
                  : t("暂无笔记", "No notes yet")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-mx-xs">
              <Button variant="subtle" onClick={() => setArchived((v) => !v)}>
                {archived
                  ? t("返回笔记", "Active notes")
                  : t("已归档", "Archived")}
              </Button>
              <Button ref={newNoteButton} onClick={(e) => edit(undefined, e.currentTarget)}>
                {t("写笔记", "New note")}
              </Button>
            </div>
          </div>
          {notes.length > 0 && (
            <div className="mx-note-list">
              {notes.map((note) => {
                const revision = note.revisions.at(-1)!;
                const content = revision.content;
                const noteError = !editor && errors?.get(note.id);
                return (
                  <article key={note.id}>
                    <div className="mx-note-heading">
                      <h3>{content.title}</h3>
                      <time dateTime={revision.savedAt}>{formatDateTime(revision.savedAt, locale, timeZone)}</time>
                    </div>
                    {content.thesis && (
                      <p className="mx-preserve-lines">{content.thesis}</p>
                    )}
                    {content.invalidation && (
                      <div className="mx-note-invalidation">
                        <strong>
                          {t("需要重新评估的条件", "Reconsider if")}
                        </strong>
                        <p className="mx-preserve-lines">
                          {content.invalidation}
                        </p>
                      </div>
                    )}
                    {content.reviewDate && (
                      <p>
                        {t("复核日期", "Review date")} ·{" "}
                        <time>{content.reviewDate}</time>
                      </p>
                    )}
                    {content.modelId && !fund && (
                      <button
                        className="mx-text-link"
                        onClick={() =>
                          update({
                            notebook: "models",
                            model: content.modelId ?? null,
                          })
                        }
                      >
                        {t("关联模型", "Linked model")} ↗
                      </button>
                    )}
                    {!!content.evidenceUrls?.length && (
                      <ul className="mx-note-links">
                        {content.evidenceUrls.map((url) => (
                          <li key={url}>
                            <a href={url} target="_blank" rel="noreferrer">
                              {new URL(url).hostname} ↗
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-wrap items-center gap-mx-xs">
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        onClick={(e) => edit(note, e.currentTarget)}
                      >
                        {t("编辑", "Edit")}
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        onClick={() => setHistory(note)}
                      >
                        {t("历史版本", "Revisions")} ({note.revisions.length})
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        disabled={pending.some(({ id }) => id === note.id)}
                        onClick={() =>
                          changeNote({
                            action: "archive",
                            id: note.id,
                            content: {
                              ...content,
                              archived: !archived,
                              expectedRevision: revision.revision,
                            },
                          })
                        }
                      >
                        {archived ? t("恢复", "Restore") : t("归档", "Archive")}
                      </Button>
                    </div>
                    {noteError && <p role="alert">{noteErrorText(noteError)}</p>}
                  </article>
                );
              })}
            </div>
          )}
          {!editor && (createError || (save.isError && save.variables?.action === "archive")) && (
            <p role="alert">
              {createError ? noteErrorText(createError) : t(
                "保存失败，请刷新后重试。",
                "Save failed. Refresh and try again.",
              )}
            </p>
          )}
        </Panel>
      )}
      <Drawer
        position="right"
        size="lg"
        opened={opened}
        onClose={dismissEditor}
        closeOnEscape={false}
        returnFocus={false}
        onExitTransitionEnd={() => {
          const active = document.activeElement;
          if (!active || active === document.body || active.closest("[data-note-editor='true']")) {
            const target = returnFocusTo.current?.isConnected ? returnFocusTo.current : newNoteButton.current;
            target?.focus({ preventScroll: true });
          }
        }}
        data-note-editor="true"
        title={
          editor?.note
            ? t("编辑笔记", "Edit note")
            : t("新笔记", "New note")
        }
      >
        <form
          className="mx-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            const current = editorRef.current;
            if (!current || conflict) return;
            const reviewDate = new FormData(e.currentTarget).get("reviewDate");
            changeNote({
              action: "save",
              id: current.note?.id,
              content: toNoteInput(current.draft, current.note, reviewDate),
            });
          }}
        >
          <TextInput
            label={t("标题", "Title")}
            required
            readOnly={readOnly}
            maxLength={200}
            value={draft.title}
            onChange={(e) => updateDraft({ title: e.currentTarget.value })}
          />
          <Textarea
            label={t("投资判断与依据", "Thesis & evidence")}
            minRows={7}
            autosize
            readOnly={readOnly}
            maxRows={18}
            value={draft.thesis}
            onChange={(e) => updateDraft({ thesis: e.currentTarget.value })}
          />
          <Textarea
            label={t("什么会改变这个判断", "What would change this thesis")}
            minRows={3}
            autosize
            readOnly={readOnly}
            value={draft.invalidation}
            onChange={(e) => updateDraft({ invalidation: e.currentTarget.value })}
          />
          <Textarea
            label={t("证据链接 · 每行一个", "Evidence links · one per line")}
            readOnly={readOnly}
            value={draft.urls}
            onChange={(e) => updateDraft({ urls: e.currentTarget.value })}
          />
          <Select
            clearable
            readOnly={readOnly}
            label={t("关联模型版本", "Related model version")}
            value={draft.modelId}
            onChange={(v) => updateDraft({ modelId: v })}
            data={(query.data?.models ?? []).map((m) => ({
              value: m.id,
              label: `${m.savedAt.slice(0, 16).replace("T", " ")} · ${m.preview.horizon}Y · ${quoteValue(m.preview.scenarios.base.value, m.preview.basis.currency)}`,
            }))}
          />
          <TextInput
            type="date"
            name="reviewDate"
            readOnly={readOnly}
            label={t("复核日期", "Review date")}
            value={draft.reviewDate ?? ""}
            onChange={(e) =>
              updateDraft({ reviewDate: e.currentTarget.value || null })
            }
          />
          {editorError && <p role="alert">{noteErrorText(editorError)}</p>}
          {conflict && (
            <div className="flex flex-wrap items-center gap-mx-xs">
              <Button
                type="button"
                variant="default"
                loading={editingAction === "load"}
                disabled={readOnly}
                onClick={() => resolveConflict("load")}
              >
                {t("载入最新版本", "Load latest")}
              </Button>
              <Button
                type="button"
                loading={editingAction === "keep"}
                disabled={readOnly || !draft.title.trim()}
                onClick={() => resolveConflict("keep")}
              >
                {t("用我的内容覆盖", "Keep my version")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-mx-xs">
            <Button
              type="submit"
              flex={1}
              loading={editingAction === "save"}
              disabled={readOnly || conflict || !draft.title.trim()}
            >
              {t("保存笔记", "Save note")}
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="default"
                disabled={readOnly}
                onClick={discardEditor}
              >
                {t("放弃草稿", "Discard draft")}
              </Button>
            )}
          </div>
        </form>
      </Drawer>
      <Drawer
        position="right"
        size="lg"
        opened={Boolean(history)}
        onClose={() => setHistory(null)}
        title={t("笔记历史", "Note history")}
      >
        <div className="mx-note-list">
          {history?.revisions
            .slice()
            .reverse()
            .map((r) => (
              <article key={r.revision}>
                <time>
                  {formatDateTime(r.savedAt, locale, timeZone)} · #{r.revision}
                </time>
                <h3>{r.content.title}</h3>
                <p className="mx-preserve-lines">{r.content.thesis}</p>
                {r.content.invalidation && (
                  <p className="mx-preserve-lines">
                    {t("重新评估条件：", "Reconsider if: ")}
                    {r.content.invalidation}
                  </p>
                )}
              </article>
            ))}
        </div>
      </Drawer>
    </>
  );
}

function ModelVersions({ journal }: { journal: Journal }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { params, update } = useRouteState("push");
  const models = journal.models ?? [];
  const notice = useEvidenceNotice(journal.ticker);
  const client = useQueryClient();
  const baseline = useMutation({
    mutationFn: (modelId: string | null) =>
      api<Journal>(
        `/research/${encodeURIComponent(journal.ticker)}/models/baseline`,
        jsonRequest("PUT", { modelId }),
      ),
    onSuccess: (updated) => {
      client.setQueryData(["research-journal", journal.ticker], updated);
      void client.invalidateQueries({ queryKey: ["dashboard-lens", "latest", "overview"] });
    },
  });
  const [compare, setCompare] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [scenario, setScenario] = useState("base");
  const detail = models.find((m) => m.id === opened);
  const selected =
    models.find((m) => m.id === params.get("model")) ?? models[0];
  const second =
    models.find((m) => m.id === compare) ??
    models.find((m) => m.id !== selected?.id);
  const columns = selected
    ? [selected, ...(second && second.id !== selected.id ? [second] : [])]
    : [];
  const options = models.map((m) => ({
    value: m.id,
    label: `${m.savedAt.slice(0, 16).replace("T", " ")} UTC · ${m.preview.horizon}Y`,
  }));
  return (
    <>
      <Panel
        title={t("已保存的模型", "Saved models")}
        action={
          models.length > 0 && (
            <div className="flex flex-wrap items-center gap-mx-md">
              <Select
                aria-label={t("模型版本", "Model version")}
                value={selected.id}
                data={options}
                onChange={(v) => update({ model: v })}
              />
              <Select
                aria-label={t("比较模型", "Compare model")}
                value={second?.id ?? null}
                data={options.filter((o) => o.value !== selected.id)}
                onChange={setCompare}
              />
            </div>
          )
        }
      >
        {!models.length ? (
          <Empty title={t("在估值页保存一个模型版本", "Save a model version from Valuation")} />
        ) : (
          <div
            className="mx-table-scroll"
            role="region"
            tabIndex={0}
            aria-label={t("冻结模型对比", "Saved model comparison")}
          >
            <table className="mx-financial-table">
              <thead>
                <tr>
                  <th>{t("模型内容", "Model detail")}</th>
                  {columns.map((m) => (
                    <th key={m.id}>
                      {m.savedAt.slice(0, 16).replace("T", " ")} UTC
                      <Button
                        display="block"
                        variant="subtle"
                        size="compact-xs"
                        disabled={baseline.isPending}
                        aria-pressed={m.id === journal.baselineModelId}
                        onClick={() => baseline.mutate(m.id === journal.baselineModelId ? null : m.id)}
                      >
                        {m.id === journal.baselineModelId
                          ? t("取消基准", "Clear baseline")
                          : t("设为基准", "Set as baseline")}
                      </Button>
                      <Button display="block" variant="subtle" size="compact-xs" onClick={() => setOpened(m.id)}>
                        {t("查看底稿", "Open worksheet")}
                      </Button>
                      {notice?.modelId === m.id && <>
                        <Button display="block" w="fit-content" variant="subtle" size="compact-xs" component={Link}
                          href={`/research?ticker=${encodeURIComponent(journal.ticker)}&view=valuation&valuationView=scenario&evidence=open`}
                          aria-describedby="model-evidence-notice">
                          {t("看新证据", "See new evidence")}
                          <span className="mx-evidence-dot" aria-hidden="true" />
                        </Button>
                        <span id="model-evidence-notice" className="sr-only">
                          {t("有新证据：", "New evidence: ") + noticeKinds(notice, t)}
                        </span>
                      </>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{t("模型", "Model")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>
                      {m.preview.basis.family === "residual-income"
                        ? t("剩余收益", "Residual income")
                        : m.preview.basis.family === "net-income"
                          ? t("净利润", "Net income")
                          : t("股权现金流", "Equity cash flow")}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>{t("预测年限", "Horizon")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>{m.preview.horizon}</td>
                  ))}
                </tr>
                <tr>
                  <th>{t("保存时现价", "Price at save")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>{quoteValue(m.preview.basis.spot, m.preview.basis.currency)}</td>
                  ))}
                </tr>
                {(["revenue", "shares", "startMargin"] as const).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {
                        [
                          t("起始营收", "Starting revenue"),
                          t("起始股数", "Starting shares"),
                          t("起始利润率", "Starting margin"),
                        ][i]
                      }
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {k === "startMargin"
                          ? percent(m.preview.basis[k])
                          : (k === "revenue"
                            ? quoteValue(m.preview.basis.revenue, m.preview.basis.currency, { style: "compact", locale }) +
                              " " + quoteUnit(m.preview.basis.currency).currency
                            : compact(m.preview.basis[k], locale))}
                      </td>
                    ))}
                  </tr>
                ))}
                {(["bear", "base", "bull"] as const).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {[t("保守估值", "Bear value"), t("中性估值", "Base value"), t("乐观估值", "Bull value")][i]}
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {quoteValue(m.preview.scenarios[k].value, m.preview.basis.currency)}
                        <ValuationFloorNote adjustment={m.preview.scenarios[k].equityFloorAdjustment} />
                      </td>
                    ))}
                  </tr>
                ))}
                {(
                  [
                    "revenueCagr",
                    "targetFcfMargin",
                    "discountRate",
                    "shareCagr",
                    "exitFcfMultiple",
                    "rampYears",
                    "initialRoe",
                    "payout",
                    "terminalPb",
                  ] as const
                ).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {
                        [
                          t("营收增长", "Revenue growth"),
                          t("目标利润率", "Target margin"),
                          t("股权资本成本", "Cost of equity"),
                          t("股数增长", "Share growth"),
                          t("终值倍数", "Exit multiple"),
                          t("达到目标的年数", "Years to target margin"),
                          t("第一年 ROE", "Year-one ROE"),
                          t("派息率", "Payout"),
                          t("终值市净率", "Terminal P/B"),
                        ][i]
                      }{" "}
                      · {t("中性", "Base")}
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {(m.preview.basis.family === "residual-income" &&
                          !["discountRate", "initialRoe", "payout", "terminalPb"].includes(k)) ||
                        m.preview.scenarios.base.inputs[k] == null
                          ? "—"
                          : k === "rampYears"
                            ? String(m.preview.scenarios.base.inputs[k])
                            : k === "exitFcfMultiple" || k === "terminalPb"
                              ? m.preview.scenarios.base.inputs[k] + "×"
                              : percent(m.preview.scenarios.base.inputs[k])}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>{t("终值贡献", "Terminal contribution")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>{percent(m.preview.scenarios.base.terminalContribution)}</td>
                  ))}
                </tr>
                <tr>
                  <th>{t("计算版本", "Formula version")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>{m.preview.formulaVersion}</td>
                  ))}
                </tr>
                <tr>
                  <th>{t("数据版本", "Data version")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>
                      <code title={m.preview.basis.dataVersion}>{m.preview.basis.dataVersion.slice(0, 12)}</code>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {baseline.isError && <p role="alert">{t("基准设置失败", "Baseline change failed")}</p>}
      <Drawer
        opened={Boolean(detail)}
        onClose={() => setOpened(null)}
        position="right"
        size="xl"
        title={t("保存时的模型底稿", "Saved model worksheet")}
      >
        {detail && (
          <>
            <p>
              {detail.savedAt.slice(0, 16).replace("T", " ")} UTC · {detail.preview.horizon}Y ·{" "}
              {quoteUnit(detail.preview.basis.currency).currency}
            </p>
            {detail.reason && (
              <div className="mx-saved-reason">
                <h3>{t("判断理由", "Rationale")}</h3>
                <p>{detail.reason}</p>
              </div>
            )}
            <Segments
              label={t("底稿情景", "Worksheet scenario")}
              value={scenario}
              onChange={setScenario}
              options={[
                { value: "bear", label: t("保守", "Bear") },
                { value: "base", label: t("中性", "Base") },
                { value: "bull", label: t("乐观", "Bull") },
              ]}
            />
            <EvidenceTable
              label={t("逐年现金流底稿", "Annual cash-flow worksheet")}
              rows={detail.preview.scenarios[scenario].years}
              columns={[
                { label: t("年", "Year"), value: (r) => String(r.year) },
                {
                  label:
                    detail.preview.basis.family === "residual-income"
                      ? t("期末每股净资产", "Closing book / share")
                      : t("营收", "Revenue"),
                  value: (r) => quoteValue(r.closingBook ?? r.revenue, detail.preview.basis.currency, { style: "compact", locale }),
                  numeric: true,
                },
                {
                  label:
                    detail.preview.basis.family === "residual-income"
                      ? t("每股剩余收益", "Residual earnings / share")
                      : detail.preview.basis.family === "net-income"
                        ? t("净利润", "Net income")
                        : t("现金流", "Cash flow"),
                  value: (r) =>
                    quoteValue(
                      detail.preview.basis.family === "residual-income" ? r.cashflowPerShare : r.freeCashflow,
                      detail.preview.basis.currency,
                      { style: "compact", locale },
                    ),
                  numeric: true,
                },
                {
                  label: t("折现系数", "Discount factor"),
                  value: (r) => number(r.discountFactor, 4),
                  numeric: true,
                },
                {
                  label: t("每股现值", "Present value / share"),
                  value: (r) => quoteValue(r.presentValue, detail.preview.basis.currency),
                  numeric: true,
                },
              ]}
            />
            <p>
              {t("每股价值", "Value per share")}:{" "}
              {quoteValue(detail.preview.scenarios[scenario].value, detail.preview.basis.currency)}
              <ValuationFloorNote adjustment={detail.preview.scenarios[scenario].equityFloorAdjustment} />
            </p>
            <details>
              <summary>{t("冻结的输入与来源", "Frozen inputs & sources")}</summary>
              <EvidenceTable
                label={t("模型来源", "Model sources")}
                rows={detail.preview.basis.evidence ?? []}
                columns={[
                  {
                    label: t("来源字段", "Source field"),
                    value: (r) => r.field,
                  },
                  {
                    label: t("披露日期", "Published"),
                    value: (r) => r.publishedAt ?? "—",
                  },
                  {
                    label: t("文件", "Document"),
                    value: (r) =>
                      safeUrl(r.url ?? "") ? (
                        <a href={safeUrl(r.url ?? "")} target="_blank" rel="noreferrer">
                          {r.source} ↗
                        </a>
                      ) : (
                        r.source
                      ),
                  },
                ]}
              />
              {(detail.preview.references ?? []).map((r, i) => (
                <p key={i}>
                  {r.period} · {percent(r.value)} · {r.source} · {r.asOf}
                </p>
              ))}
            </details>
          </>
        )}
      </Drawer>
    </>
  );
}
