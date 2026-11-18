"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ClockCounterClockwise, Plus, Square, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { ASSISTANT_NAME, conversationsErasedEvent } from "../assistant-settings";
import { api } from "../data";
import { useCopy } from "../foundation";
import { errorLabel } from "./status-label";
import { CardTitle, EvidenceLink, ReadingLines } from "./cards";
import { useAssistant, type RoleCard } from "./context";
import { focusAssistantControl } from "./focus";
import { verifiedLines } from "./chat-reply";
import { chatContext, displayTurns, sourceLabel } from "./evidence";

// getRandomValues is available on loopback and existing HTTP workspaces.
function makeConversationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
const transport = new DefaultChatTransport({
  api: "/api/backend/assistant/chat?format=references",
  prepareSendMessagesRequest: ({ id, messages, body }) => ({
    body: { ...body, id, trigger: "submit-message", messages: messages.slice(-1) },
  }),
});
function unverifiedNotice(t: ReturnType<typeof useCopy>) {
  return t("无法核实这次回复。", "This reply could not be verified.");
}
function ChatAnswer({ message, pending }: { message: UIMessage; pending: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (pending) return null;
  const lines = verifiedLines(message, locale, timeZone);
  if (!lines.length) return <p className="mx-assistant-note">{unverifiedNotice(t)}</p>;
  return lines.map((line, i) => <p className="mx-reading-line" key={i}>{line.text}{" "}
    {line.evidence ? <EvidenceLink evidence={line.evidence}/> : <span className="mx-reading-source">{sourceLabel(null, t)}</span>}
  </p>);
}
function failureCode(message: string) {
  if (/^[a-z_]{1,64}$/.test(message)) return message;
  try {
    const code = JSON.parse(message).detail?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "assistant_unavailable";
  } catch { return "assistant_unavailable"; }
}
type SidebarProps = { checking: boolean; page: string; search: string; scopeLabel: string; composerRef: (node: HTMLTextAreaElement | null) => void };
function Thread({ page, search, scopeLabel, checking, composerRef, initial, history, onHistory, onNew }: SidebarProps & {
  history: boolean; initial: { id: string; messages: UIMessage[]; sequence: number }; onHistory: () => void; onNew: () => void;
}) {
  const t = useCopy();
  const { timeZone, locale } = useLocale();
  const { open, ready, pending, close, pageCard, handoff } = useAssistant();
  const [draft, setDraft] = useState("");
  const [contextCard, setContextCard] = useState<RoleCard | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const wasHistory = useRef(history);
  const submitted = useRef<{text:string; card:RoleCard | null}>({text:"",card:null});
  const [announcement, setAnnouncement] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(initial.sequence);
  const client = useQueryClient();
  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    id: initial.id, messages: initial.messages, transport,
    onFinish: ({messages: completed, isAbort, isError, isDisconnect}) => {
      void client.invalidateQueries({ queryKey: ["assistant-conversations"] });
      const reply = displayTurns(completed).at(-1);
      if (!isAbort && !isError && !isDisconnect && reply?.role === "assistant") {
        const lines = verifiedLines(reply, locale, timeZone);
        setAnnouncement(lines.length
          ? lines.map(line => line.text + " " + sourceLabel(line.evidence, t)).join(" ")
          : unverifiedNotice(t));
      }
    },
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => () => { void stop(); }, [stop]);
  useEffect(() => { if (!ready) void stop(); }, [ready, stop]);
  useEffect(() => {
    if (open && wasHistory.current && !history) focusAssistantControl(historyButton.current);
    wasHistory.current = history;
  }, [open, history]);
  useEffect(() => {
    const el = scroller.current;
    if (el && open && el.scrollHeight - el.scrollTop - el.clientHeight < 320) el.scrollTop = el.scrollHeight;
  }, [messages, open]);
  // A page handoff is explicit. Ordinary navigation only changes the scope of
  // the next turn and never replaces or sends the current draft.
  if (handoff && seen !== handoff.sequence) {
    setSeen(handoff.sequence);
    setDraft(handoff.draft);
    setContextCard(handoff.card);
  }
  const context = chatContext(page, search, timeZone);
  const card: RoleCard = contextCard ?? pageCard ?? {
    role: "", title: t("工作区解读", "Workspace reading"), object: scopeLabel,
    questions: [t("最近有哪些变化？", "What has changed recently?"), t("哪些数据还不完整？", "Which data is incomplete?"), t("本期的主要变动是什么？", "What moved most this period?")],
  };
  const sendingBlocked = !ready || pending || card.pendingBinding;
  function send(value: string) {
    const text = value.trim();
    if (!text || busy || sendingBlocked) return;
    clearError();
    const origin = card.origin ?? {page, search, snapshotId:card.reading?.snapshotId ?? undefined};
    const turn = card.role ? {...chatContext(origin.page, origin.search, timeZone), role:card.role, object:card.context ?? {}, snapshotId:origin.snapshotId} : context;
    submitted.current = {text, card:card.role ? {...card, origin} : null};
    setAnnouncement("");
    setDraft("");
    void sendMessage({ text }, { body: { context:turn } });
    setContextCard(null);
  }
  const turns = displayTurns(messages);
  return <>
    <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><div>
      <button disabled={busy} onClick={onNew} aria-label={t("新对话", "New conversation")}><Plus /></button>
      <button ref={historyButton} disabled={busy} onClick={onHistory} aria-label={t("历史对话", "Conversation history")}><ClockCounterClockwise /></button>
      <button data-assistant-dismiss onClick={close} aria-label={t("关闭侧栏", "Close sidebar")}><X /></button>
    </div></div>
    <div className="mx-assistant-transcript" ref={scroller} aria-label={t("对话", "Conversation")}>
      {!messages.length && <div className="mx-assistant-opening"><CardTitle card={card} /><ReadingLines card={card} />
        <div className="mx-assistant-questions">{card.questions.map(q => <button key={q} disabled={sendingBlocked} onClick={() => send(q)}>{q}<span aria-hidden="true">→</span></button>)}</div>
      </div>}
      {turns.map(m => <div key={m.id} className={"mx-assistant-turn mx-turn-" + m.role}>
        {m.role === "user" ? m.parts.map((p, i) => p.type === "text" ? <p key={i}>{p.text}</p> : null) : <ChatAnswer message={m} pending={busy && m === turns.at(-1)} />}
      </div>)}
      {busy && <p className="mx-assistant-note" role="status">{t("正在读取", "Reading ")}{scopeLabel}…</p>}
      {error && <p role="alert">{errorLabel(failureCode(error.message), t)}</p>}
    </div>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    <form className="mx-assistant-composer" onSubmit={e => { e.preventDefault(); send(draft); }}>
      <span className="mx-assistant-scope">{checking ? t("正在检查连接…", "Checking connection…") : contextCard?.object || [context.ticker, scopeLabel].filter(Boolean).join(" · ")}</span>
      <div><textarea ref={history ? null : composerRef} rows={2} value={draft} onChange={e => setDraft(e.target.value)} maxLength={16000}
        aria-label={t("消息", "Message")} placeholder={t("给 {name} 发消息…", "Message {name}…").replace("{name}", ASSISTANT_NAME)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
        {busy ? <button type="button" onClick={event => { event.preventDefault(); void stop(); setDraft(submitted.current.text); setContextCard(submitted.current.card); }} aria-label={t("停止", "Stop")}><Square weight="fill" /></button>
          : <button type="submit" disabled={sendingBlocked || !draft.trim()} aria-label={t("发送", "Send")}><ArrowUp weight="bold" /></button>}
      </div>
    </form>
  </>;
}
function History({ select, back, removed }: { select: (id: string, messages: UIMessage[]) => void; back: () => void; removed: (id: string) => void }) {
  const t = useCopy();
  const client = useQueryClient();
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { focusAssistantControl(backButton.current); }, []);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ready } = useAssistant();
  const conversations = useQuery({ enabled: ready, queryKey: ["assistant-conversations"], queryFn: ({ signal }) => api<{ id: string; title: string | null }[]>("/assistant/conversations", { signal }), retry: false });
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), [ready]);
  async function act(id: string, erase: boolean) {
    if (!ready || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    const {signal} = controller;
    setBusy(true); setError(false);
    try {
      const path = "/assistant/conversations/" + encodeURIComponent(id);
      if (erase) { await api(path, { method: "DELETE", signal }); removed(id); await client.invalidateQueries({ queryKey: ["assistant-conversations"] }); }
      else { const data = await api<{ messages: UIMessage[] }>(path, {signal}); select(id, data.messages); }
    } catch { if (!signal.aborted) setError(true); } finally { action.current = null; setBusy(false); }
  }
  return <><div className="mx-assistant-heading"><strong>{t("历史对话", "Conversation history")}</strong><button data-assistant-dismiss ref={backButton} onClick={back} aria-label={t("返回对话", "Back to conversation")}><X /></button></div>
    <div className="mx-assistant-transcript">{conversations.data?.map(c => <div className="mx-assistant-history" key={c.id}>
      <button disabled={busy} onClick={() => void act(c.id, false)}>{c.title || t("对话", "Conversation")}</button>
      <button disabled={busy} onClick={() => void act(c.id, true)} aria-label={t("删除对话", "Delete conversation") + " · " + (c.title || "")}><Trash /></button>
    </div>)}{conversations.data?.length === 0 && <p>{t("暂无已保存的对话。", "No saved conversations yet.")}</p>}
    {(error || conversations.isError) && <p role="alert">{t("无法读取或更新对话。", "Could not read or update the conversation.")}</p>}</div></>;
}
export default function AssistantSidebar(props: SidebarProps) {
  const { handoff } = useAssistant();
  const [initial, setInitial] = useState(() => ({ id: makeConversationId(), messages: [] as UIMessage[], sequence: 0 }));
  const [history, setHistory] = useState(false);
  const fresh = () => setInitial({ id: makeConversationId(), messages: [], sequence: handoff?.sequence ?? 0 });
  useEffect(() => {
    const erased = () => {
      setInitial({id:makeConversationId(), messages:[], sequence:handoff?.sequence ?? 0});
      setHistory(false);
    };
    window.addEventListener(conversationsErasedEvent, erased);
    return () => window.removeEventListener(conversationsErasedEvent, erased);
  }, [handoff?.sequence]);
  return <>
    <div className="mx-assistant-thread" hidden={history}><Thread key={initial.id} {...props} initial={initial} history={history} onNew={fresh} onHistory={() => setHistory(true)} /></div>
    {history && <History back={() => setHistory(false)} select={(id, messages) => { setInitial({ id, messages, sequence: handoff?.sequence ?? 0 }); setHistory(false); }}
      removed={id => { if (id === initial.id) fresh(); }} />}
  </>;
}
