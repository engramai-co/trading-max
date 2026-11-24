"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ClockCounterClockwise, Plus, Square, Trash, X } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { ASSISTANT_NAME, conversationsErasedEvent } from "../assistant-settings";
import { api } from "../data";
import { useCopy } from "../foundation";
import { isImeComposing } from "../shortcut-platform";
import { CardTitle, EvidenceLink, ReadingLines } from "./cards";
import { useAssistant, type RoleCard } from "./context";
import { focusAssistantControl } from "./focus";
import { verifiedInterruptedLines, verifiedLines } from "./chat-reply";
import { readableDates, sourceLabel } from "./evidence";
import {
  extractTurnContext,
  formatTurnContext,
  resolveTurnTarget,
  type TurnContext,
} from "./turn-context";
import {
  INITIAL_TURN_STORE,
  assistantMessageForUserTurn,
  beginTurnAttempt,
  failureCode,
  isRetryableStatus,
  pairConversationTurns,
  settleTurnAttempt,
  shouldRestoreDraftOnStop,
  stopTurnAttempt,
  turnAnnouncementText,
  turnStatusText,
  withoutPublication,
  type TurnRecord,
  type TurnStore,
} from "./turn-state";
import { extractWorkSteps, stepStatusLabel, type WorkStep } from "./work-steps";

// getRandomValues is available on loopback and existing HTTP workspaces.
function makeConversationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

type AttemptState = {
  id: number;
  userMessageId: string;
  sawFinish: boolean;
  sawAbort: boolean;
  errorCode?: string;
  httpStatus?: number;
  snapshotId?: string;
  draftRevision: number;
  stopped: boolean;
};

class TurnTrackingTransport extends DefaultChatTransport<UIMessage> {
  private attempt: AttemptState | null = null;

  constructor() {
    super({
      api: "/api/backend/assistant/chat?format=references",
      prepareSendMessagesRequest: ({ id, messages, body }) => ({
        body: { ...body, id, trigger: "submit-message", messages: messages.slice(-1) },
      }),
      fetch: async (input, init) => {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const attempt = this.attempt;
        const response = await globalThis.fetch(input, init);
        if (attempt && !attempt.stopped && !init?.signal?.aborted) {
          attempt.httpStatus = response.status;
          const snapshotId = response.headers.get("x-assistant-snapshot-id");
          if (response.ok && snapshotId && /^[A-Za-z0-9_-]{1,100}$/.test(snapshotId)) {
            attempt.snapshotId = snapshotId;
          }
        }
        return response;
      },
    });
  }

  hasAttempt() {
    return this.attempt !== null;
  }

  startAttempt(attempt: AttemptState) {
    this.attempt = attempt;
  }

  recordError(message: string) {
    const attempt = this.attempt;
    if (attempt && !attempt.stopped) attempt.errorCode = failureCode(message, attempt.httpStatus);
  }

  stopAttempt() {
    const attempt = this.attempt;
    if (!attempt || attempt.stopped) return null;
    attempt.stopped = true;
    return attempt;
  }

  finishAttempt() {
    const attempt = this.attempt;
    this.attempt = null;
    return attempt?.stopped ? null : attempt;
  }

  override async sendMessages(
    options: Parameters<DefaultChatTransport<UIMessage>["sendMessages"]>[0],
  ) {
    const attempt = this.attempt;
    const stream = await super.sendMessages(options);
    if (!attempt) return stream;
    if (options.abortSignal?.aborted) {
      await stream.cancel().catch(() => undefined);
      throw new DOMException("Aborted", "AbortError");
    }
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (attempt.stopped || options.abortSignal?.aborted) return;
          if (chunk.type === "finish") attempt.sawFinish = true;
          else if (chunk.type === "abort") attempt.sawAbort = true;
          controller.enqueue(chunk);
        },
      }),
    );
  }
}

function unverifiedNotice(t: ReturnType<typeof useCopy>) {
  return t("无法核实这次回复。", "This reply could not be verified.");
}

function VerifiedLines({ lines }: { lines: ReturnType<typeof verifiedLines> }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  return lines.map((line, i) => (
    <p className="mx-reading-line" key={i}>
      {readableDates(line.text, locale, timeZone)}{" "}
      {line.evidence ? <EvidenceLink evidence={line.evidence} /> : <span className="mx-reading-source">{sourceLabel(null, t)}</span>}
    </p>
  ));
}

function WorkStepItems({ steps }: { steps: WorkStep[] }) {
  const { locale } = useLocale();
  return (
    <ol className="mx-assistant-step-list" role="list">
      {steps.map(step => (
        <li key={step.id} data-step-status={step.status}>
          <span>{step.label}</span>
          <span className="mx-assistant-step-status">{stepStatusLabel(step.status, locale)}</span>
        </li>
      ))}
    </ol>
  );
}

function WorkStepsDisclosure({ steps }: { steps: WorkStep[] }) {
  const t = useCopy();
  if (!steps.length) return null;
  return (
    <details className="mx-assistant-steps">
      <summary>{t("工作过程", "Work steps")}</summary>
      <WorkStepItems steps={steps} />
    </details>
  );
}

function readingSelectionKey(card: RoleCard) {
  return hashKey([card.context, card.origin?.research]);
}

type EditedOrigin = Pick<TurnRecord, "requestContext" | "turnContext" | "card">;
type SidebarProps = { checking: boolean; page: string; scopeLabel: string; composerRef: (node: HTMLTextAreaElement | null) => void };

function Thread({ page, scopeLabel, checking, composerRef, initial, history, onHistory, onNew }: SidebarProps & {
  history: boolean; initial: { id: string; messages: UIMessage[]; sequence: number }; onHistory: () => void; onNew: () => void;
}) {
  const t = useCopy();
  const { timeZone, locale } = useLocale();
  const params = useSearchParams();
  const search = params.toString();
  const route = page + "?" + search;
  const { open, ready, pending, close, pageCard, handoff, pageContext, researchChartWindows } = useAssistant();
  const [draft, setDraft] = useState("");
  const [handoffBinding, setHandoffBinding] = useState<{ card: RoleCard; sentFrom?: string; selectionAtSend?: string } | null>(null);
  const [editedOrigin, setEditedOrigin] = useState<EditedOrigin | null>(null);
  const [turnStore, setTurnStore] = useState<TurnStore>(INITIAL_TURN_STORE);
  const historyButton = useRef<HTMLButtonElement>(null);
  const textareaElement = useRef<HTMLTextAreaElement | null>(null);
  const wasHistory = useRef({ history, sequence: handoff?.sequence });
  const turnStoreRef = useRef<TurnStore>(INITIAL_TURN_STORE);
  const nextAttemptRef = useRef(0);
  const draftRevision = useRef(0);
  const [transport] = useState(() => new TurnTrackingTransport());
  const restoredFromStopRef = useRef<{ text: string; userMessageId: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(initial.sequence);
  const client = useQueryClient();

  const setComposerNode = useCallback((node: HTMLTextAreaElement | null) => {
    textareaElement.current = node;
    composerRef(node);
  }, [composerRef]);

  const { messages, sendMessage, stop, status, clearError } = useChat({
    id: initial.id,
    messages: initial.messages,
    transport,
    onError: err => transport.recordError(err.message),
    onFinish: ({ messages: completed, isAbort, isError, isDisconnect, finishReason }) => {
      const attempt = transport.finishAttempt();
      if (!attempt) return;
      const assistantMessage = assistantMessageForUserTurn(completed, attempt.userMessageId);
      const settled = settleTurnAttempt(turnStoreRef.current, {
        attemptId: attempt.id,
        assistantMessage,
        isAbort,
        isDisconnect,
        isError,
        sawFinish: attempt.sawFinish,
        sawAbort: attempt.sawAbort,
        finishReason,
        errorCode: attempt.errorCode,
        snapshotId: attempt.snapshotId,
        locale,
        timeZone,
      });
      turnStoreRef.current = settled.store;
      setTurnStore(settled.store);
      if (settled.announcement?.kind === "completed") {
        void client.invalidateQueries({ queryKey: ["assistant-conversations"] });
      }
      if (settled.announcement && ready) {
        setAnnouncement(turnAnnouncementText(settled.announcement, locale, timeZone, t));
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";
  useEffect(() => () => {
    transport.stopAttempt();
    transport.finishAttempt();
    void stop();
  }, [stop, transport]);
  useEffect(() => { if (!ready) void stop(); }, [ready, stop]);
  useEffect(() => {
    if (open && wasHistory.current.history && !history && wasHistory.current.sequence === handoff?.sequence) {
      focusAssistantControl(historyButton.current);
    }
    wasHistory.current = { history, sequence: handoff?.sequence };
  }, [open, history, handoff?.sequence]);
  useEffect(() => {
    const el = scroller.current;
    if (el && open && el.scrollHeight - el.scrollTop - el.clientHeight < 320) el.scrollTop = el.scrollHeight;
  }, [messages, turnStore, open]);

  const liveSelection = pageCard && handoffBinding && pageCard.role === handoffBinding.card.role &&
    (pageCard.origin?.page ?? page) === (handoffBinding.card.origin?.page ?? page) ? readingSelectionKey(pageCard) : undefined;
  // Keep the unsent draft bound. Later questions follow a new selection in the same reading.
  if (handoff && seen !== handoff.sequence) {
    setSeen(handoff.sequence);
    setDraft(handoff.draft);
    setHandoffBinding({ card: handoff.card });
    setEditedOrigin(null);
  } else if (handoffBinding?.sentFrom && (
    !open || handoffBinding.sentFrom !== route || (liveSelection && liveSelection !== handoffBinding.selectionAtSend)
  )) {
    setHandoffBinding(null);
  }

  const card: RoleCard = editedOrigin?.card ?? handoffBinding?.card ?? pageCard ?? {
    role: "",
    title: t("工作区解读", "Workspace reading"),
    object: scopeLabel,
    questions: [
      t("最近有哪些变化？", "What has changed recently?"),
      t("哪些数据还不完整？", "Which data is incomplete?"),
      t("本期的主要变动是什么？", "What moved most this period?"),
    ],
  };
  const chart = page === "research" && (pageContext?.lens === "overview" || pageContext?.lens === "technical")
    ? researchChartWindows[pageContext.lens] : undefined;
  const selection = pageContext?.page === page ? pageContext : undefined;
  const displayedSelection = chart && selection && !selection.observation && chart.identity === selection.ticker
    ? { ...selection, range: chart.range, snapshotId: chart.snapshotId ?? selection.snapshotId } : selection;
  const evidence = params.get("evidence");
  const marketCitation = Boolean(params.get("snapshotId")) && (evidence === "market_sector" || evidence === "global_map");
  // Keep the opening card visible when the ordinary composer has a different target.
  const usePageForComposer = !handoffBinding && !editedOrigin && (
    Boolean(card.origin?.research?.indexId) ||
    (page === "sectors" && !marketCitation) ||
    (card.role === "habits" && selection?.observation?.kind === "decision")
  );
  const openingTarget = editedOrigin ?? resolveTurnTarget(card, page, search, timeZone, displayedSelection);
  const resolved = usePageForComposer ? resolveTurnTarget(null, page, search, timeZone, displayedSelection) : openingTarget;
  const composerContextLabel = formatTurnContext(resolved.turnContext, locale, timeZone) || scopeLabel;
  const readingPending = !editedOrigin && Boolean(card.pendingBinding);
  const sendingBlocked = !ready || pending || (!usePageForComposer && readingPending);

  function launchAttempt(params: {
    text: string;
    requestContext: Record<string, unknown>;
    turnContext: TurnContext;
    boundCard: RoleCard | null;
    replaceUserMessageId?: string;
    frozenAssistant?: UIMessage | null;
  }) {
    clearError();
    const userMessageId = params.replaceUserMessageId ?? makeConversationId();
    const attemptId = ++nextAttemptRef.current;
    const attempt: AttemptState = {
      id: attemptId,
      userMessageId,
      sawFinish: false,
      sawAbort: false,
      draftRevision: draftRevision.current,
      stopped: false,
    };
    transport.startAttempt(attempt);
    const nextStore = beginTurnAttempt(turnStoreRef.current, {
      userMessageId,
      attemptId,
      prompt: params.text,
      requestContext: params.requestContext,
      turnContext: params.turnContext,
      card: params.boundCard,
      frozenAssistant: params.frozenAssistant,
    });
    turnStoreRef.current = nextStore;
    setTurnStore(nextStore);
    setAnnouncement("");

    void sendMessage({
      id: userMessageId,
      ...(params.replaceUserMessageId ? { messageId: userMessageId } : {}),
      role: "user",
      parts: [{ type: "text", text: params.text }],
    }, { body: { context: params.requestContext } });
  }

  function send(value: string, target = resolved) {
    const text = value.trim();
    if (!text || busy || transport.hasAttempt() || sendingBlocked) return;
    restoredFromStopRef.current = null;
    setDraft("");
    if (handoffBinding && !handoffBinding.sentFrom && !editedOrigin) {
      setHandoffBinding({
        ...handoffBinding, sentFrom: route, selectionAtSend: liveSelection ?? readingSelectionKey(handoffBinding.card),
      });
    }
    setEditedOrigin(null);
    launchAttempt({
      text,
      requestContext: target.requestContext,
      turnContext: target.turnContext,
      boundCard: target.card,
    });
  }

  function handleStop() {
    const attempt = transport.stopAttempt();
    if (!attempt) return;
    const active = turnStoreRef.current.active;
    if (active) {
      const currentAssistant = assistantMessageForUserTurn(messages, active.userMessageId);
      const stopped = stopTurnAttempt(turnStoreRef.current, active.attemptId, currentAssistant, attempt.snapshotId);
      const currentRecord = stopped.store.turns[active.userMessageId];
      turnStoreRef.current = stopped.store;
      setTurnStore(stopped.store);
      if (stopped.announcement) {
        setAnnouncement(turnAnnouncementText(stopped.announcement, locale, timeZone, t));
      }
      if (currentRecord && shouldRestoreDraftOnStop(draft, draftRevision.current !== attempt.draftRevision)) {
        setDraft(currentRecord.prompt);
        setEditedOrigin(currentRecord);
        restoredFromStopRef.current = { text: currentRecord.prompt, userMessageId: currentRecord.userMessageId };
      }
    }
    void stop();
  }

  function retryTurn(record: TurnRecord, useCurrentData = false) {
    if (busy || transport.hasAttempt() || !ready || pending) return;
    if (
      restoredFromStopRef.current?.userMessageId === record.userMessageId &&
      restoredFromStopRef.current.text === draft
    ) {
      setDraft("");
      setEditedOrigin(null);
      restoredFromStopRef.current = null;
    }
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const replaceUserMessageId = lastUser?.id === record.userMessageId ? record.userMessageId : undefined;
    // Bound reading objects require their source publication. An expired
    // reading can be asked again as an ordinary question in the same page scope.
    launchAttempt({
      text: record.prompt,
      requestContext: useCurrentData ? withoutPublication(record.requestContext) : record.requestContext,
      turnContext: useCurrentData ? withoutPublication(record.turnContext) : record.turnContext,
      boundCard: useCurrentData ? null : record.card,
      replaceUserMessageId: useCurrentData ? undefined : replaceUserMessageId,
      frozenAssistant: !useCurrentData && record.frozenAssistant && verifiedInterruptedLines(record.frozenAssistant, locale, timeZone).length
        ? record.frozenAssistant : undefined,
    });
  }

  function editTurnPrompt(record: TurnRecord) {
    if (busy) return;
    restoredFromStopRef.current = null;
    setDraft(record.prompt);
    setEditedOrigin(record);
    focusAssistantControl(textareaElement.current);
  }

  const exchanges = pairConversationTurns(messages);
  return <>
    <div className="mx-assistant-heading"><strong>{ASSISTANT_NAME}</strong><div>
      <button disabled={busy} onClick={onNew} aria-label={t("新对话", "New conversation")}><Plus /></button>
      <button ref={historyButton} disabled={busy} onClick={onHistory} aria-label={t("历史对话", "Conversation history")}><ClockCounterClockwise /></button>
      <button data-assistant-dismiss onClick={close} aria-label={t("关闭侧栏", "Close sidebar")}><X /></button>
    </div></div>
    <div className="mx-assistant-transcript" ref={scroller} aria-label={t("对话", "Conversation")}>
      {!messages.length && <div className="mx-assistant-opening"><CardTitle card={card} />{card.status && <p role="status" className="mx-assistant-note">{card.status}</p>}<ReadingLines card={card} />
        <div className="mx-assistant-questions">{card.questions.map(q => <button key={q} disabled={sendingBlocked || readingPending} onClick={() => send(q, openingTarget)}>{q}<span aria-hidden="true">→</span></button>)}</div>
      </div>}
      {exchanges.map(exchange => {
        const record = exchange.user ? turnStore.turns[exchange.user.id] : undefined;
        const userContext = exchange.user
          ? (record?.turnContext ?? extractTurnContext(exchange.user))
          : null;
        const userContextLabel = userContext ? formatTurnContext(userContext, locale, timeZone) : "";
        const interrupted = record && isRetryableStatus(record.status) ? record.status : null;
        const streamingTurn = record?.status === "streaming";
        const effectiveAssistant = interrupted ? (record?.frozenAssistant ?? null) : (exchange.assistant ?? null);
        const steps = extractWorkSteps(effectiveAssistant, Boolean(streamingTurn), locale);
        const verify = interrupted ? verifiedInterruptedLines : verifiedLines;
        const verified = !streamingTurn && effectiveAssistant ? verify(effectiveAssistant, locale, timeZone) : [];
        const retained = streamingTurn && record.frozenAssistant
          ? verifiedInterruptedLines(record.frozenAssistant, locale, timeZone) : [];
        const showAssistantTurn = Boolean(effectiveAssistant || record);

        return <Fragment key={exchange.id}>
          {exchange.user && (
            <div className="mx-assistant-turn mx-turn-user">
              {userContextLabel && <span className="mx-assistant-turn-context">{userContextLabel}</span>}
              {exchange.user.parts.map((p, i) => p.type === "text" ? <p key={i}>{p.text}</p> : null)}
            </div>
          )}
          {showAssistantTurn && (
            <div
              className="mx-assistant-turn mx-turn-assistant"
              data-turn-status={record?.status}
            >
              {streamingTurn ? (
                <>
                  {steps.length > 0 ? (
                    <div className="mx-assistant-work" role="status">
                      <WorkStepItems steps={steps} />
                    </div>
                  ) : (
                    <p className="mx-assistant-note" role="status">
                      {t("正在读取", "Reading ")}{userContextLabel || scopeLabel}…
                    </p>
                  )}
                  <VerifiedLines lines={retained} />
                </>
              ) : interrupted && record ? (
                <>
                  <p className="mx-assistant-turn-status">
                    {turnStatusText(interrupted, record.errorCode, verified.length > 0, t)}
                  </p>
                  <WorkStepsDisclosure steps={steps} />
                  {verified.length > 0 && <VerifiedLines lines={verified} />}
                  <div className="mx-assistant-turn-actions">
                    {record.errorCode === "assistant_snapshot_missing" ? (
                      <button type="button" disabled={busy || !ready || pending} onClick={() => retryTurn(record, true)}>
                        {t("使用当前数据重新提问", "Ask again with current data")}
                      </button>
                    ) : (
                      <>
                        <button type="button" disabled={busy || !ready || pending} onClick={() => retryTurn(record)}>
                          {t("重试", "Retry")}
                        </button>
                        <button type="button" disabled={busy} onClick={() => editTurnPrompt(record)}>
                          {t("编辑问题", "Edit prompt")}
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <WorkStepsDisclosure steps={steps} />
                  {verified.length > 0 ? (
                    <VerifiedLines lines={verified} />
                  ) : (
                    <p className="mx-assistant-note">{unverifiedNotice(t)}</p>
                  )}
                </>
              )}
            </div>
          )}
        </Fragment>;
      })}
    </div>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    <form className="mx-assistant-composer" onSubmit={e => { e.preventDefault(); send(draft); }}>
      <span className="mx-assistant-scope">{checking ? t("正在检查连接…", "Checking connection…") : composerContextLabel}</span>
      <div><textarea ref={history ? null : setComposerNode} rows={2} value={draft}
        onChange={e => {
          draftRevision.current++;
          restoredFromStopRef.current = null;
          setDraft(e.target.value);
        }} maxLength={16000}
        aria-label={t("消息", "Message")} placeholder={t("给 {name} 发消息…", "Message {name}…").replace("{name}", ASSISTANT_NAME)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        {busy ? <button type="button" onClick={event => { event.preventDefault(); handleStop(); }} aria-label={t("停止", "Stop")}><Square weight="fill" /></button>
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
    const { signal } = controller;
    setBusy(true); setError(false);
    try {
      const path = "/assistant/conversations/" + encodeURIComponent(id);
      if (erase) { await api(path, { method: "DELETE", signal }); removed(id); await client.invalidateQueries({ queryKey: ["assistant-conversations"] }); }
      else { const data = await api<{ messages: UIMessage[] }>(path, { signal }); select(id, data.messages); }
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
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const sequence = handoff?.sequence ?? 0;
  const history = historyAt === sequence;
  const fresh = () => setInitial({ id: makeConversationId(), messages: [], sequence: handoff?.sequence ?? 0 });
  useEffect(() => {
    const erased = () => {
      setInitial({ id: makeConversationId(), messages: [], sequence: handoff?.sequence ?? 0 });
      setHistoryAt(null);
    };
    window.addEventListener(conversationsErasedEvent, erased);
    return () => window.removeEventListener(conversationsErasedEvent, erased);
  }, [handoff?.sequence]);
  return <>
    <div className="mx-assistant-thread" hidden={history}><Thread key={initial.id} {...props} initial={initial} history={history} onNew={fresh} onHistory={() => setHistoryAt(sequence)} /></div>
    {history && <History back={() => setHistoryAt(null)} select={(id, messages) => { setInitial({ id, messages, sequence: handoff?.sequence ?? 0 }); setHistoryAt(null); }}
      removed={id => { if (id === initial.id) fresh(); }} />}
  </>;
}
