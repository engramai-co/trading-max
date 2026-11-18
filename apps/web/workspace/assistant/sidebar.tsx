"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ClockCounterClockwise, Plus, Square, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { ASSISTANT_NAME } from "../assistant-settings";
import { api } from "../data";
import { useCopy } from "../foundation";
import Link from "../link";
import { CardTitle, EvidenceLink, ReadingLines } from "./cards";
import { useAssistant, type RoleCard } from "./context";
import { chatContext, messageEvidence } from "./evidence";

const transport = new DefaultChatTransport({
  api: "/api/backend/assistant/chat",
  prepareSendMessagesRequest: ({ id, messages, body }) => ({
    body: { ...body, id, trigger: "submit-message", messages: messages.slice(-1) },
  }),
});
function ChatAnswer({ message }: { message: UIMessage }) {
  const refs = messageEvidence(message);
  const text = message.parts.filter(p => p.type === "text").map(p => p.text).join("");
  return text.split(/\n+/).filter(Boolean).map((line, i) => <p className="mx-reading-line" key={i}>
    {line.split(/(\[ev_[a-zA-Z0-9_-]+\])/).map((part, j) => {
      if (!part.startsWith("[ev_")) return part;
      const evidence = refs.get(part.slice(1, -1));
      return evidence ? <EvidenceLink key={j} evidence={evidence} /> : null;
    })}
  </p>);
}
function errorLabel(code: string, t: ReturnType<typeof useCopy>) {
  if (code === "assistant_busy" || code === "provider_rate_limited") return t("服务繁忙，稍后重试。", "The service is busy. Try again shortly.");
  if (code === "assistant_consent_required" || code === "assistant_disabled") return t("请在设置中启用助手并确认数据共享。", "Enable the assistant and confirm data sharing in Settings.");
  if (code === "provider_auth_failed" || code === "provider_not_configured") return t("请在设置中检查模型连接。", "Check the model connection in Settings.");
  return t("这次解读未能完成。", "This reading could not be completed.");
}
function failureCode(message: string) {
  if (/^[a-z_]{1,64}$/.test(message)) return message;
  try {
    const code = JSON.parse(message).detail?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "assistant_unavailable";
  } catch { return "assistant_unavailable"; }
}
function Thread({ page, search, scopeLabel, initial, onHistory, onNew }: {
  page: string; search: string; scopeLabel: string; initial: { id: string; messages: UIMessage[] }; onHistory: () => void; onNew: () => void;
}) {
  const t = useCopy();
  const { timeZone } = useLocale();
  const { open, close, pageCard, handoff } = useAssistant();
  const [draft, setDraft] = useState("");
  const [contextCard, setContextCard] = useState<RoleCard | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef(handoff?.sequence ?? 0);
  const client = useQueryClient();
  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    id: initial.id, messages: initial.messages, transport,
    onFinish: () => { void client.invalidateQueries({ queryKey: ["assistant-conversations"] }); },
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => () => { void stop(); }, [stop]);
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const el = scroller.current;
    if (el && open && el.scrollHeight - el.scrollTop - el.clientHeight < 320) el.scrollTop = el.scrollHeight;
  }, [messages, open]);
  // A page handoff is explicit. Ordinary navigation only changes the scope of
  // the next turn and never replaces or sends the current draft.
  if (handoff && seen.current !== handoff.sequence) {
    seen.current = handoff.sequence;
    setDraft(handoff.draft);
    setContextCard(handoff.card);
  }
  const context = chatContext(page, search, timeZone);
  const card = contextCard ?? pageCard ?? {
    role: "", title: t("工作区解读", "Workspace reading"), object: scopeLabel,
    questions: [t("最近有哪些变化？", "What has changed recently?"), t("哪些数据还不完整？", "Which data is incomplete?"), t("本期的主要变动是什么？", "What moved most this period?")],
  };
  function send(value: string) {
    const text = value.trim();
    if (!text || busy) return;
    clearError();
    setDraft("");
    void sendMessage({ text }, { body: { context: { ...context, ...(card.role ? { role: card.role, object: card.context ?? {} } : {}) } } });
    setContextCard(null);
  }
  return <>
    <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><div>
      <button disabled={busy} onClick={onNew} aria-label={t("新对话", "New conversation")}><Plus /></button>
      <button disabled={busy} onClick={onHistory} aria-label={t("历史对话", "Conversation history")}><ClockCounterClockwise /></button>
      <button onClick={close} aria-label={t("关闭侧栏", "Close sidebar")}><X /></button>
    </div></div>
    <div className="mx-assistant-transcript" ref={scroller} aria-label={t("对话", "Conversation")}>
      {!messages.length && <div className="mx-assistant-opening"><CardTitle card={card} /><ReadingLines card={card} />
        <div className="mx-assistant-questions">{card.questions.map(q => <button key={q} onClick={() => send(q)}>{q}<span aria-hidden="true">→</span></button>)}</div>
      </div>}
      {messages.map(m => <div key={m.id} className={"mx-assistant-turn mx-turn-" + m.role}>
        {m.role === "user" ? m.parts.map((p, i) => p.type === "text" ? <p key={i}>{p.text}</p> : null) : <ChatAnswer message={m} />}
      </div>)}
      {busy && <p className="mx-assistant-note" role="status">{t("正在读取", "Reading ")}{scopeLabel}…</p>}
      {error && <p role="alert">{errorLabel(failureCode(error.message), t)}</p>}
    </div>
    <form className="mx-assistant-composer" onSubmit={e => { e.preventDefault(); send(draft); }}>
      <span className="mx-assistant-scope">{contextCard?.object || [context.ticker, scopeLabel].filter(Boolean).join(" · ")}</span>
      <div><textarea ref={input} rows={2} value={draft} onChange={e => setDraft(e.target.value)} maxLength={16000}
        aria-label={t("消息", "Message")} placeholder={t("给 " + ASSISTANT_NAME + " 发消息…", "Message " + ASSISTANT_NAME + "…")}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
        {busy ? <button type="button" onClick={() => { void stop(); const last = messages.filter(m => m.role === "user").at(-1);
          setDraft(last?.parts.flatMap(p => p.type === "text" ? [p.text] : []).join("") ?? ""); }} aria-label={t("停止", "Stop")}><Square weight="fill" /></button>
          : <button type="submit" disabled={!draft.trim()} aria-label={t("发送", "Send")}><ArrowUp weight="bold" /></button>}
      </div>
    </form>
  </>;
}
function History({ select, back, removed }: { select: (id: string, messages: UIMessage[]) => void; back: () => void; removed: (id: string) => void }) {
  const t = useCopy();
  const client = useQueryClient();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const conversations = useQuery({ queryKey: ["assistant-conversations"], queryFn: ({ signal }) => api<{ id: string; title: string | null }[]>("/assistant/conversations", { signal }), retry: false });
  async function act(id: string, erase: boolean) {
    setBusy(true); setError(false);
    try {
      const path = "/assistant/conversations/" + encodeURIComponent(id);
      if (erase) { await api(path, { method: "DELETE" }); removed(id); await client.invalidateQueries({ queryKey: ["assistant-conversations"] }); }
      else { const data = await api<{ messages: UIMessage[] }>(path); select(id, data.messages); }
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <><div className="mx-assistant-heading"><strong>{t("历史对话", "Conversation history")}</strong><button onClick={back} aria-label={t("返回对话", "Back to conversation")}><X /></button></div>
    <div className="mx-assistant-transcript">{conversations.data?.map(c => <div className="mx-assistant-history" key={c.id}>
      <button disabled={busy} onClick={() => void act(c.id, false)}>{c.title || t("对话", "Conversation")}</button>
      <button disabled={busy} onClick={() => void act(c.id, true)} aria-label={t("删除对话", "Delete conversation") + " · " + (c.title || "")}><Trash /></button>
    </div>)}{conversations.data?.length === 0 && <p>{t("暂无已保存的对话。", "No saved conversations yet.")}</p>}
    {(error || conversations.isError) && <p role="alert">{t("无法读取或更新对话。", "Could not read or update the conversation.")}</p>}</div></>;
}
export default function AssistantSidebar({ page, search, scopeLabel }: { page: string; search: string; scopeLabel: string }) {
  const t = useCopy();
  const { ready, pending, code, close } = useAssistant();
  const [initial, setInitial] = useState(() => ({ id: crypto.randomUUID(), messages: [] as UIMessage[] }));
  const [history, setHistory] = useState(false);
  const fresh = () => setInitial({ id: crypto.randomUUID(), messages: [] });
  if (!ready) return <>
    <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><button onClick={close} aria-label={t("关闭侧栏", "Close sidebar")}><X /></button></div>
    <div className="mx-assistant-opening"><p>{pending ? t("正在检查连接…", "Checking connection…") : errorLabel(code ?? "assistant_unavailable", t)}</p>
    {!pending && <Link href="/settings?tab=assistant" onClick={close} className="mx-text-link">{t("打开设置", "Open Settings")} →</Link>}</div></>;
  return <>
    <div className="mx-assistant-thread" hidden={history}><Thread key={initial.id} {...{page, search, scopeLabel, initial}} onNew={fresh} onHistory={() => setHistory(true)} /></div>
    {history && <History back={() => setHistory(false)} select={(id, messages) => { setInitial({ id, messages }); setHistory(false); }}
      removed={id => { if (id === initial.id) fresh(); }} />}
  </>;
}
