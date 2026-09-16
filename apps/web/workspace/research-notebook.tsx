"use client";

import type { components } from "@/lib/api-schema";
import type { ResearchLensSnapshot } from "@/lib/types";
import {
  Button,
  Drawer,
  Group,
  Select,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  compact,
  currency,
  jsonRequest,
  number,
  percent,
  safeUrl,
} from "./data";
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

type Journal = components["schemas"]["ResearchJournal"];
type Note = components["schemas"]["ResearchNote"];
type NoteInput = components["schemas"]["ResearchNoteInput"];
const blank: NoteInput = {
  title: "",
  archived: false,
  thesis: "",
  invalidation: "",
  evidenceUrls: [],
  reviewDate: null,
  modelId: null,
};

export function ResearchNotebook({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const client = useQueryClient();
  const { params, update } = useRouteState("push");
  const section = params.get("notebook") ?? "notes";
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const [input, setInput] = useState<NoteInput>(blank);
  const [urls, setUrls] = useState("");
  const [history, setHistory] = useState<Note | null>(null);
  const query = useQuery({
    queryKey: ["research-journal", data.ticker],
    queryFn: ({ signal }) =>
      api<Journal>(`/research/${encodeURIComponent(data.ticker)}/journal`, { signal }),
    enabled: section === "notes" || section === "models",
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: ({ content, id }: { content: NoteInput; id?: string }) =>
      api<Journal>(
        `/research/${encodeURIComponent(data.ticker)}/journal${id ? "/" + id : ""}`,
        jsonRequest(id ? "PUT" : "POST", content),
      ),
    onSuccess: (journal) => {
      client.setQueryData(["research-journal", data.ticker], journal);
      setEditing(null);
    },
  });
  const edit = (note?: Note) => {
    const latest = note?.revisions.at(-1);
    setInput(
      latest ? { ...latest.content, expectedRevision: latest.revision } : blank,
    );
    setUrls((latest?.content.evidenceUrls ?? []).join("\n"));
    save.reset();
    setEditing(note ?? "new");
  };
  const notes = (query.data?.notes ?? [])
    .filter((n) => Boolean(n.revisions.at(-1)?.content.archived) === archived)
    .slice()
    .reverse();
  return (
    <>
      <Segments
        label={t("研究记录内容", "Research record contents")}
        value={section}
        onChange={(v) => update({ notebook: v })}
        options={[
          { value: "notes", label: t("研究笔记", "Notes") },
          { value: "models", label: t("模型版本", "Model versions") },
          { value: "filings", label: t("公司披露", "Disclosures") },
          { value: "news", label: t("新闻", "News") },
        ]}
      />
      {section === "filings" || section === "news" ? (
        <ResearchDocuments data={data} news={section === "news"} />
      ) : query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : section === "models" ? (
        <ModelVersions journal={query.data} />
      ) : (
        <Panel
          title={t("研究笔记", "Research notes")}
          action={
            <Group>
              <Button variant="subtle" onClick={() => setArchived((v) => !v)}>
                {archived
                  ? t("返回笔记", "Active notes")
                  : t("已归档", "Archived")}
              </Button>
              <Button onClick={() => edit()}>{t("写笔记", "New note")}</Button>
            </Group>
          }
        >
          {!notes.length ? (
            <Empty
              title={
                archived
                  ? t("没有归档笔记", "No archived notes")
                  : t(
                      "记录你的判断与验证条件",
                      "Record your thesis and what would change it",
                    )
              }
            />
          ) : (
            <div className="mx-note-list">
              {notes.map((note) => {
                const revision = note.revisions.at(-1)!;
                const content = revision.content;
                return (
                  <article key={note.id}>
                    <div className="mx-note-heading">
                      <h3>{content.title}</h3>
                      <time>{revision.savedAt.slice(0, 10)}</time>
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
                    {content.modelId && (
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
                    <Group gap="xs">
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        onClick={() => edit(note)}
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
                        disabled={save.isPending}
                        onClick={() =>
                          save.mutate({
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
                    </Group>
                  </article>
                );
              })}
            </div>
          )}
          {save.isError && !editing && (
            <p role="alert">
              {t(
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
        opened={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={
          editing === "new"
            ? t("新笔记", "New note")
            : t("编辑笔记", "Edit note")
        }
      >
        <form
          className="mx-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            const reviewDate = new FormData(e.currentTarget).get("reviewDate");
            save.mutate({
              id: editing && editing !== "new" ? editing.id : undefined,
              content: {
                ...input,
                reviewDate:
                  typeof reviewDate === "string" && reviewDate
                    ? reviewDate
                    : null,
                title: input.title.trim(),
                evidenceUrls: urls
                  .split(/\n/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              },
            });
          }}
        >
          <TextInput
            label={t("标题", "Title")}
            required
            maxLength={200}
            value={input.title}
            onChange={(e) =>
              setInput({ ...input, title: e.currentTarget.value })
            }
          />
          <Textarea
            label={t("投资判断与依据", "Thesis & evidence")}
            minRows={7}
            autosize
            maxRows={18}
            value={input.thesis ?? ""}
            onChange={(e) =>
              setInput({ ...input, thesis: e.currentTarget.value })
            }
          />
          <Textarea
            label={t("什么会改变这个判断", "What would change this thesis")}
            minRows={3}
            autosize
            value={input.invalidation ?? ""}
            onChange={(e) =>
              setInput({ ...input, invalidation: e.currentTarget.value })
            }
          />
          <Textarea
            label={t("证据链接 · 每行一个", "Evidence links · one per line")}
            value={urls}
            onChange={(e) => setUrls(e.currentTarget.value)}
          />
          <Select
            clearable
            label={t("关联模型版本", "Related model version")}
            value={input.modelId ?? null}
            onChange={(v) => setInput({ ...input, modelId: v })}
            data={(query.data?.models ?? []).map((m) => ({
              value: m.id,
              label: `${m.savedAt.slice(0, 16).replace("T", " ")} · ${m.preview.horizon}Y · ${currency(m.preview.scenarios.base.value, m.preview.basis.currency, 2)}`,
            }))}
          />
          <TextInput
            type="date"
            name="reviewDate"
            label={t("复核日期", "Review date")}
            value={input.reviewDate ?? ""}
            onChange={(e) =>
              setInput({ ...input, reviewDate: e.currentTarget.value || null })
            }
          />
          {save.isError && (
            <p role="alert">
              {t(
                "保存失败。请检查链接是否完整；若笔记已在其他窗口修改，关闭后刷新再编辑。",
                "Could not save. Check evidence URLs; if another window edited the note, close and reload before editing.",
              )}
            </p>
          )}
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!input.title.trim()}
          >
            {t("保存笔记", "Save note")}
          </Button>
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
                  {r.savedAt.slice(0, 19).replace("T", " ")} UTC · #{r.revision}
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
  const { params, update } = useRouteState("push");
  const models = journal.models ?? [];
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
            <Group>
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
            </Group>
          )
        }
      >
        {!models.length ? (
          <Empty
            title={t(
              "在估值页保存一个模型版本",
              "Save a model version from Valuation",
            )}
          />
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
                        onClick={() => setOpened(m.id)}
                      >
                        {t("查看底稿", "Open worksheet")}
                      </Button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{t("预测年限", "Horizon")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>{m.preview.horizon}</td>
                  ))}
                </tr>
                <tr>
                  <th>{t("保存时现价", "Spot at save")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>
                      {currency(
                        m.preview.basis.spot,
                        m.preview.basis.currency,
                        2,
                      )}
                    </td>
                  ))}
                </tr>
                {(["revenue", "shares", "startMargin"] as const).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {
                        [
                          t("起始营收", "Starting revenue"),
                          t("起始股数", "Starting shares"),
                          t("起始现金流率", "Starting FCF margin"),
                        ][i]
                      }
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {k === "startMargin"
                          ? percent(m.preview.basis[k])
                          : compact(m.preview.basis[k]) +
                            (k === "revenue"
                              ? " " + m.preview.basis.currency
                              : "")}
                      </td>
                    ))}
                  </tr>
                ))}
                {(["bear", "base", "bull"] as const).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {
                        [
                          t("保守估值", "Bear value"),
                          t("基准估值", "Base value"),
                          t("乐观估值", "Bull value"),
                        ][i]
                      }
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {currency(
                          m.preview.scenarios[k].value,
                          m.preview.basis.currency,
                          2,
                        )}
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
                  ] as const
                ).map((k, i) => (
                  <tr key={k}>
                    <th>
                      {
                        [
                          t("营收增长", "Revenue growth"),
                          t("目标现金流率", "Target FCF margin"),
                          t("股权资本成本", "Cost of equity"),
                          t("股数增长", "Share growth"),
                          t("终值倍数", "Exit multiple"),
                        ][i]
                      }{" "}
                      · {t("基准", "Base")}
                    </th>
                    {columns.map((m) => (
                      <td key={m.id}>
                        {k === "exitFcfMultiple"
                          ? m.preview.scenarios.base.inputs[k] + "×"
                          : percent(m.preview.scenarios.base.inputs[k])}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>{t("终值贡献", "Terminal contribution")}</th>
                  {columns.map((m) => (
                    <td key={m.id}>
                      {percent(m.preview.scenarios.base.terminalContribution)}
                    </td>
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
                      <code title={m.preview.basis.dataVersion}>
                        {m.preview.basis.dataVersion.slice(0, 12)}
                      </code>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
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
              {detail.savedAt.slice(0, 16).replace("T", " ")} UTC ·{" "}
              {detail.preview.horizon}Y · {detail.preview.basis.currency}
            </p>
            <Segments
              label={t("底稿情景", "Worksheet scenario")}
              value={scenario}
              onChange={setScenario}
              options={[
                { value: "bear", label: t("保守", "Bear") },
                { value: "base", label: t("基准", "Base") },
                { value: "bull", label: t("乐观", "Bull") },
              ]}
            />
            <EvidenceTable
              label={t("逐年现金流底稿", "Annual cash-flow worksheet")}
              rows={detail.preview.scenarios[scenario].years}
              columns={[
                { label: t("年", "Year"), value: (r) => String(r.year) },
                {
                  label: t("营收", "Revenue"),
                  value: (r) => compact(r.revenue),
                  numeric: true,
                },
                {
                  label: t("现金流", "Cash flow"),
                  value: (r) => compact(r.freeCashflow),
                  numeric: true,
                },
                {
                  label: t("折现系数", "Discount factor"),
                  value: (r) => number(r.discountFactor, 4),
                  numeric: true,
                },
                {
                  label: t("每股现值", "Present value / share"),
                  value: (r) => number(r.presentValue, 2),
                  numeric: true,
                },
              ]}
            />
            <p>
              {t("每股估值", "Value per share")}:{" "}
              {currency(
                detail.preview.scenarios[scenario].value,
                detail.preview.basis.currency,
                2,
              )}
            </p>
            <details>
              <summary>
                {t("冻结的输入与来源", "Frozen inputs & sources")}
              </summary>
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
                        <a
                          href={safeUrl(r.url ?? "")}
                          target="_blank"
                          rel="noreferrer"
                        >
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
