"use client";

import { Button } from "@/components/ui/button";
import { AlertDialogDescription } from "@/components/ui/alert-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDateTime } from "@/ui/formatters";
import type { components } from "@/lib/api-schema";
import { useBreakpoint } from "@/lib/hooks";
import { WorkspaceAlertDialog } from "../overlay";
import { AssistantRuntimeProvider, AuiConfig, ThreadPrimitive, Tools } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage, type UIMessageChunk } from "ai";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, ChartNoAxesCombined, ChevronDown, ChevronRight,
  ChevronLeft, History as HistoryIcon, PanelRightClose, Pencil, RotateCw, Square, SquarePen, Trash, X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { ASSISTANT_NAME, conversationsErasedEvent } from "../assistant-settings";
import { ApiError, api, number, object, readApi } from "../data";
import { StatusMessage, useCopy } from "../foundation";
import { isImeComposing } from "../shortcut-platform";
import { CardTitle, EvidenceLink, ReadingLines } from "./cards";
import { useAssistant, type RoleCard } from "./context";
import { focusAssistantControl } from "./focus";
import { replyText, verifiedInterruptedLines, verifiedLines } from "./chat-reply";
import { citationPreview, readableDates, sourceLabel } from "./evidence";
import { phoneRecordHref, useAssistantRecordNavigation } from "./citation";
import Link from "../link";
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
import { ChatWorkSteps, workToolkit } from "./tool-ui";
import { HoldingsPicker } from "./holdings-picker";
import { PriceRecord } from "./price-record";

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
  startedAt?: number;
  requestContext: Record<string, unknown>;
  toolStarts: Map<string, number>;
};

function attemptDuration(attempt: AttemptState) {
  return attempt.startedAt === undefined ? 0 : Math.round((performance.now() - attempt.startedAt) / 1000);
}

function needsApproval(message: UIMessage | null | undefined) {
  return message?.role === "assistant" && message.parts.some(part => isToolUIPart(part) && part.state === "approval-requested");
}

class TurnTrackingTransport extends DefaultChatTransport<UIMessage> {
  private attempt: AttemptState | null = null;

  constructor(private readonly onToolElapsed: (userId: string, callId: string, elapsedMs: number) => void) {
    super({
      api: "/api/backend/assistant/chat?format=references",
      prepareSendMessagesRequest: ({ id, messages, body }) => ({
        body: { context: this.attempt?.requestContext, ...body, id, trigger: "submit-message", messages: messages.slice(-1) },
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

  resumeAttempt(attempt: AttemptState) {
    this.attempt = {
      ...attempt, sawFinish: false, sawAbort: false, errorCode: undefined, httpStatus: undefined,
      startedAt: attempt.startedAt ?? performance.now(),
      requestContext: attempt.snapshotId ? { ...attempt.requestContext, snapshotId: attempt.snapshotId } : attempt.requestContext,
    };
  }

  startAttempt(attempt: Omit<AttemptState, "startedAt" | "toolStarts">) {
    this.attempt = { ...attempt, startedAt: performance.now(), toolStarts: new Map() };
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
    const onToolElapsed = this.onToolElapsed;
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (attempt.stopped || options.abortSignal?.aborted) return;
          if (chunk.type === "finish") attempt.sawFinish = true;
          else if (chunk.type === "abort") attempt.sawAbort = true;
          else if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
            if (!attempt.toolStarts.has(chunk.toolCallId)) attempt.toolStarts.set(chunk.toolCallId, performance.now());
          } else if ((chunk.type === "tool-output-available" && !chunk.preliminary) ||
              chunk.type === "tool-output-error" || chunk.type === "tool-output-denied" || chunk.type === "tool-input-error") {
            const start = attempt.toolStarts.get(chunk.toolCallId);
            if (start !== undefined) {
              attempt.toolStarts.delete(chunk.toolCallId);
              onToolElapsed(attempt.userMessageId, chunk.toolCallId, Math.max(0, performance.now() - start));
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
  }
}

function unverifiedNotice(t: ReturnType<typeof useCopy>) {
  return t("无法核实这次回复。", "This reply could not be verified.");
}

function AnswerText({text, move}: {text: string; move?: ReturnType<typeof verifiedLines>[number]["move"]}) {
  const index = move ? text.indexOf(move.text) : -1;
  if (!move || index < 0) return text;
  return <>{text.slice(0, index)}<strong className="mx-assistant-answer-move" data-tone={move.tone}>{move.text}</strong>{
    text.slice(index + move.text.length)
  }</>;
}

const VerifiedLines = memo(function VerifiedLines({ lines, showRecord = false }: { lines: ReturnType<typeof verifiedLines>; showRecord?: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  return lines.map((line, i) => {
    const text = readableDates(line.text, locale, timeZone);
    const source = line.evidence ? <EvidenceLink evidence={line.evidence} observation={line.text} /> : <span className="mx-reading-source">{sourceLabel(null, t)}</span>;
    // Keep a short phrase beside the source, even where WebKit can wrap between Han characters.
    const tail = text.match(locale === "zh" ? /[^\s。，、；！？：]{1,6}[。，、；！？：.!?]*$/u : /\S{1,24}$/u)?.[0] ?? "";
    const moveIndex = line.move ? text.indexOf(line.move.text) : -1;
    const split = text.length - tail.length;
    const joinedAt = line.move && moveIndex >= 0 && moveIndex < split && moveIndex + line.move.text.length > split ? moveIndex : split;
    return <Fragment key={i}>
      <p className="mx-reading-line">
        <AnswerText text={text.slice(0, joinedAt)} move={line.move} />
        <span className="mx-assistant-source-tail"><AnswerText text={text.slice(joinedAt)} move={line.move} />{"\u00a0"}{source}</span>
      </p>
      {showRecord && i === 0 && line.evidence?.source === "market" &&
        <PriceRecord evidence={line.evidence} text={text} />}
    </Fragment>;
  });
});

const verifiedCache = new WeakMap<UIMessage["parts"], Map<string, ReturnType<typeof verifiedLines>>>();
function verifyMessage(message: UIMessage, locale: ReturnType<typeof useLocale>["locale"], timeZone: string, interrupted: boolean) {
  let byLocale = verifiedCache.get(message.parts);
  if (!byLocale) {
    byLocale = new Map();
    verifiedCache.set(message.parts, byLocale);
  }
  const key = [locale, timeZone, interrupted].join("/");
  const cached = byLocale.get(key);
  if (cached) return cached;
  const lines = (interrupted ? verifiedInterruptedLines : verifiedLines)(message, locale, timeZone);
  byLocale.set(key, lines);
  return lines;
}

function WorkStepItems({ steps, durations }: { steps: WorkStep[]; durations?: ReadonlyMap<string, number> }) {
  const { locale } = useLocale();
  const t = useCopy();
  return (
    <ol className="mx-assistant-step-list" role="list">
      {steps.map(step => {
        const duration = durations?.get(step.id);
        return <li key={step.id} data-step-status={step.status}>
          <span>{step.label}{step.detail && <small>{step.detail}</small>}</span>
          <span className="mx-assistant-step-status">{stepStatusLabel(step.status, locale)}
            {duration !== undefined && " · " + number(duration / 1000, 1) + t(" 秒", " s")}</span>
        </li>;
      })}
    </ol>
  );
}

function WorkStepsDisclosure({ steps, seconds, durations, children }: {
  steps: WorkStep[]; seconds?: number; durations?: ReadonlyMap<string, number>; children?: React.ReactNode;
}) {
  const t = useCopy();
  if (!steps.length) return null;
  const sources = [...new Set(steps.map(step => step.source).filter(Boolean))];
  return (
    <details className="mx-assistant-steps">
      <summary tabIndex={0}><ChevronRight size={16} aria-hidden="true" />{
        [t("工作过程", "Work steps"), sources.join(t("、", ", ")), seconds === undefined ? "" : seconds + t(" 秒", " s")].filter(Boolean).join(" · ")
      }</summary>
      {children ?? <WorkStepItems steps={steps} durations={durations} />}
    </details>
  );
}

function readingSelectionKey(card: RoleCard) {
  return hashKey([card.context, card.origin?.research]);
}

type EditedOrigin = Pick<TurnRecord, "requestContext" | "turnContext" | "card">;
type HandoffBinding = { card: RoleCard; sentFrom?: string; selectionAtSend?: string };
type ToolDurations = Map<string, ReadonlyMap<string, number>>;
type ConversationVersion = { messages: UIMessage[]; store: TurnStore; elapsed: Record<string, number>; toolDurations: ToolDurations };
type Branches = { userId: string; versions: ConversationVersion[]; selected: number; live?: ConversationVersion };
type ParkedDraft = { text: string; card: HandoffBinding | null; origin: EditedOrigin | null };
type RetainedThread = ConversationVersion & {
  id: string; sequence: number; draft: string; bound: HandoffBinding | null;
  origin: EditedOrigin | null; editId?: string; branches: Branches | null; parkedDraft?: ParkedDraft;
};

function newThread(id: string, sequence: number, messages: UIMessage[] = []): RetainedThread {
  return { id, sequence, messages, draft: "", bound: null, origin: null, store: INITIAL_TURN_STORE, elapsed: {}, toolDurations: new Map(), branches: null };
}

function restoreApproval(thread: RetainedThread, timeZone: string) {
  if (!needsApproval(thread.messages.at(-1))) return null;
  const user = thread.messages.findLast(message => message.role === "user");
  const turnContext = user && extractTurnContext(user);
  const prompt = user?.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (!user || !turnContext?.snapshotId || !prompt || thread.store.turns[user.id]) return null;
  const requestContext = { ...object(object(user.metadata).turnContext), snapshotId: turnContext.snapshotId, timezone: timeZone };
  const attempt: AttemptState = {
    id: 0, userMessageId: user.id, sawFinish: true, sawAbort: false, draftRevision: 0, stopped: false,
    snapshotId: turnContext.snapshotId, requestContext, toolStarts: new Map(),
  };
  const store = beginTurnAttempt(thread.store, {
    userMessageId: user.id, attemptId: attempt.id, prompt, requestContext, turnContext, card: null,
  });
  return { attempt, store };
}
type SidebarProps = { checking: boolean; page: string; scopeLabel: string; composerRef: (node: HTMLTextAreaElement | null) => void };

function Thread({ page, scopeLabel, checking, composerRef, initial, history, onHistory, onNew }: SidebarProps & {
  history: boolean; initial: RetainedThread; onHistory: (thread: RetainedThread) => void; onNew: (thread: RetainedThread) => void;
}) {
  const t = useCopy();
  const { timeZone, locale } = useLocale();
  const params = useSearchParams();
  const search = params.toString();
  const route = page + "?" + search;
  const { open, ready, pending, model, close, pageCard, handoff, pageContext, researchChartWindows } = useAssistant();
  const phone = useBreakpoint("phone");
  const openRecord = useAssistantRecordNavigation();
  const [draft, setDraft] = useState(initial.draft);
  const [handoffBinding, setHandoffBinding] = useState(initial.bound);
  const [editedOrigin, setEditedOrigin] = useState(initial.origin);
  const [editing, setEditing] = useState(initial.editId);
  const [branches, setBranches] = useState(initial.branches);
  const [restoredApproval] = useState(() => restoreApproval(initial, timeZone));
  const [turnStore, setTurnStore] = useState(restoredApproval?.store ?? initial.store);
  const historyButton = useRef<HTMLElement>(null);
  const textareaElement = useRef<HTMLTextAreaElement | null>(null);
  const wasHistory = useRef({ history, sequence: handoff?.sequence });
  const turnStoreRef = useRef(restoredApproval?.store ?? initial.store);
  const nextAttemptRef = useRef(0);
  const draftRevision = useRef(0);
  const [toolDurations, setToolDurations] = useState(initial.toolDurations);
  const [transport] = useState(() => new TurnTrackingTransport((userId, callId, elapsedMs) => {
    setToolDurations(current => {
      const next = new Map(current);
      const steps = new Map(next.get(userId));
      steps.set(callId, elapsedMs);
      next.set(userId, steps);
      return next;
    });
  }));
  const waitingApproval = useRef<AttemptState | null>(restoredApproval?.attempt ?? null);
  const restoredFromStopRef = useRef<{ text: string; userMessageId: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const [elapsed, setElapsed] = useState(initial.elapsed);
  const [seen, setSeen] = useState(initial.sequence);
  const [parkedDraft, setParkedDraft] = useState(initial.parkedDraft);
  const client = useQueryClient();

  const setComposerNode = useCallback((node: HTMLTextAreaElement | null) => {
    textareaElement.current = node;
    composerRef(node);
  }, [composerRef]);

  const chat = useChat({
    throttle: 48,
    id: initial.id,
    messages: initial.messages,
    transport,
    onError: err => transport.recordError(err.message),
    sendAutomaticallyWhen: ({messages}) => {
      const attempt = waitingApproval.current;
      if (!ready || pending || !attempt || !lastAssistantMessageIsCompleteWithApprovalResponses({messages})) return false;
      waitingApproval.current = null;
      transport.resumeAttempt(attempt);
      return true;
    },
    onFinish: ({ messages: completed, isAbort, isError, isDisconnect, finishReason }) => {
      const attempt = transport.finishAttempt();
      if (!attempt) return;
      const assistantMessage = assistantMessageForUserTurn(completed, attempt.userMessageId);
      if (!isAbort && !isError && attempt.sawFinish && needsApproval(assistantMessage)) {
        waitingApproval.current = attempt;
        return;
      }
      const duration = attemptDuration(attempt);
      setElapsed(current => ({ ...current, [attempt.userMessageId]: duration }));
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
        setAnnouncement(turnAnnouncementText(settled.announcement, t));
      }
    },
  });

  const runtime = useAISDKRuntime(chat, { joinStrategy: "concat-content" });
  const { messages, setMessages, sendMessage, stop, status, clearError } = chat;
  const awaitingApproval = needsApproval(messages.at(-1)) && Boolean(turnStore.active);
  const busy = status === "submitted" || status === "streaming" || awaitingApproval;
  useEffect(() => () => {
    transport.stopAttempt();
    transport.finishAttempt();
    void stop();
  }, [stop, transport]);
  useEffect(() => { if (!ready) void stop(); }, [ready, stop]);
  useEffect(() => {
    if (open && wasHistory.current.history && !history && wasHistory.current.sequence === handoff?.sequence) {
      if (!focusAssistantControl(historyButton.current)) {
        requestAnimationFrame(() => focusAssistantControl(historyButton.current));
      }
    }
    wasHistory.current = { history, sequence: handoff?.sequence };
  }, [open, history, handoff?.sequence]);


  const liveSelection = pageCard && handoffBinding && pageCard.role === handoffBinding.card.role &&
    (pageCard.origin?.page ?? page) === (handoffBinding.card.origin?.page ?? page) ? readingSelectionKey(pageCard) : undefined;
  // Keep the unsent draft bound. Later questions follow a new selection in the same reading.
  if (handoff && seen !== handoff.sequence) {
    setSeen(handoff.sequence);
    if (draft.trim()) {
      setParkedDraft({ text: draft, card: handoffBinding, origin: editedOrigin });
    }
    setDraft(handoff.draft);
    setHandoffBinding({ card: handoff.card });
    setEditedOrigin(null);
    setEditing(undefined);
  } else if (handoffBinding?.sentFrom && (
    !open || handoffBinding.sentFrom !== route || (liveSelection && liveSelection !== handoffBinding.selectionAtSend)
  )) {
    setHandoffBinding(null);
  }

  const technical = page === "research" && pageContext?.lens === "technical";
  const technicalQuestions = [
    t("最近哪些交易日波动最大？", "Which recent trading sessions moved most?"),
    t("与同行相比如何？", "How did peers perform?"),
    t("我的成本线在哪？", "Where is my cost basis?"),
  ];
  const card: RoleCard = editedOrigin?.card ?? handoffBinding?.card ?? pageCard ?? {
    role: "",
    title: technical ? t("关键时刻", "Key moments") : t("工作区解读", "Workspace reading"),
    object: technical ? pageContext?.ticker ?? scopeLabel : scopeLabel,
    questions: technical ? technicalQuestions : [
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
    setToolDurations(current => {
      if (!current.has(userMessageId)) return current;
      const next = new Map(current);
      next.delete(userMessageId);
      return next;
    });
    transport.startAttempt({
      requestContext: params.requestContext,
      id: attemptId,
      userMessageId,
      sawFinish: false,
      sawAbort: false,
      draftRevision: draftRevision.current,
      stopped: false,
    });
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
    setAnnouncement(t("正在准备回复…", "Preparing response…"));

    void sendMessage({
      id: userMessageId,
      ...(params.replaceUserMessageId ? { messageId: userMessageId } : {}),
      role: "user",
      parts: [{ type: "text", text: params.text }],
    }, { body: { context: params.requestContext } });
  }

  const browsingBranch = branches !== null && branches.selected < branches.versions.length;

  function retainThread(): RetainedThread {
    return {
      id: initial.id, sequence: seen, draft, bound: handoffBinding, origin: editedOrigin,
      editId: editing, parkedDraft, messages, store: turnStoreRef.current, elapsed, toolDurations, branches,
    };
  }

  function fork(userId: string) {
    const version = { messages, store: turnStoreRef.current, elapsed, toolDurations };
    setBranches({
      userId,
      versions: branches?.userId === userId ? [...branches.versions, version] : [version],
      selected: branches?.userId === userId ? branches.versions.length + 1 : 1,
    });
  }

  function chooseBranch(selected: number) {
    if (!branches || busy) return;
    const live = browsingBranch ? branches.live : { messages, store: turnStoreRef.current, elapsed, toolDurations };
    const version = branches.versions[selected] ?? live;
    if (!version || !live) return;
    setMessages(version.messages);
    turnStoreRef.current = version.store;
    setTurnStore(version.store);
    setElapsed(version.elapsed);
    setToolDurations(version.toolDurations);
    setBranches({ ...branches, selected, live });
  }

  function send(value: string, target: EditedOrigin = resolved) {
    const text = value.trim();
    if (!text || busy || browsingBranch || transport.hasAttempt() || sendingBlocked) return;
    if (editing) fork(editing);
    restoredFromStopRef.current = null;
    setDraft("");
    if (handoffBinding && !handoffBinding.sentFrom && !editedOrigin) {
      setHandoffBinding({
        ...handoffBinding, sentFrom: route, selectionAtSend: liveSelection ?? readingSelectionKey(handoffBinding.card),
      });
    }
    setEditedOrigin(null);
    setEditing(undefined);
    launchAttempt({
      text,
      replaceUserMessageId: editing,
      requestContext: target.requestContext,
      turnContext: target.turnContext,
      boundCard: target.card,
    });
    focusAssistantControl(textareaElement.current);
  }

  function handleStop() {
    const attempt = transport.stopAttempt() ?? waitingApproval.current;
    if (!attempt) return;
    waitingApproval.current = null;
    const duration = attemptDuration(attempt);
    setElapsed(current => ({ ...current, [attempt.userMessageId]: duration }));
    const active = turnStoreRef.current.active;
    if (active) {
      const currentAssistant = assistantMessageForUserTurn(messages, active.userMessageId);
      const stopped = stopTurnAttempt(turnStoreRef.current, active.attemptId, currentAssistant, attempt.snapshotId);
      const currentRecord = stopped.store.turns[active.userMessageId];
      turnStoreRef.current = stopped.store;
      setTurnStore(stopped.store);
      if (stopped.announcement) {
        setAnnouncement(turnAnnouncementText(stopped.announcement, t));
      }
      if (currentRecord && shouldRestoreDraftOnStop(draft, draftRevision.current !== attempt.draftRevision)) {
        setDraft(currentRecord.prompt);
        setEditedOrigin(currentRecord);
        restoredFromStopRef.current = { text: currentRecord.prompt, userMessageId: currentRecord.userMessageId };
      }
    }
    void stop();
    focusAssistantControl(textareaElement.current);
  }

  function retryTurn(record: TurnRecord, useCurrentData = false, currentTarget: EditedOrigin = record) {
    if (busy || browsingBranch || transport.hasAttempt() || !ready || pending) return;
    if (
      restoredFromStopRef.current?.userMessageId === record.userMessageId &&
      restoredFromStopRef.current.text === draft
    ) {
      setDraft("");
      setEditedOrigin(null);
      restoredFromStopRef.current = null;
    }
    const lastUser = messages.findLast(message => message.role === "user");
    const replaceUserMessageId = !useCurrentData && (record.status === "completed" || lastUser?.id === record.userMessageId)
      ? record.userMessageId : undefined;
    if (record.status === "completed" && !useCurrentData) fork(record.userMessageId);
    // Bound reading objects require their source publication. An expired
    // reading can be asked again as an ordinary question in the same page scope.
    launchAttempt({
      text: record.prompt,
      requestContext: useCurrentData ? withoutPublication(currentTarget.requestContext) : record.requestContext,
      turnContext: useCurrentData ? withoutPublication(currentTarget.turnContext) : record.turnContext,
      boundCard: useCurrentData ? null : record.card,
      replaceUserMessageId,
      frozenAssistant: !useCurrentData && record.frozenAssistant && verifiedInterruptedLines(record.frozenAssistant, locale, timeZone).length
        ? record.frozenAssistant : undefined,
    });
  }

  function editTurnPrompt(record: TurnRecord) {
    if (busy || browsingBranch) return;
    restoredFromStopRef.current = null;
    setDraft(record.prompt);
    setEditedOrigin(record);
    setEditing(record.userMessageId);
    focusAssistantControl(textareaElement.current);
  }

  const exchanges = useMemo(() => pairConversationTurns(messages), [messages]);
  return <AssistantRuntimeProvider runtime={runtime} config={AuiConfig({tools: Tools({toolkit: workToolkit})})}>
    <ThreadPrimitive.Root className="mx-assistant-thread">
    <div className="mx-assistant-heading">
      <strong><span className="mx-assistant-spark" aria-hidden="true">✦</span>{ASSISTANT_NAME}</strong>
      <div className="mx-assistant-header-actions">
        <Button variant="ghost" size="icon" tabIndex={0} disabled={busy} onClick={() => onNew(retainThread())} aria-label={t("新对话", "New conversation")}><SquarePen size={16} aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" tabIndex={0} ref={historyButton} disabled={busy} onClick={() => onHistory(retainThread())} aria-label={t("历史对话", "Conversation history")}><HistoryIcon size={16} aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" tabIndex={0} data-assistant-dismiss onClick={close} aria-label={t("关闭侧栏", "Close sidebar")}><PanelRightClose className="mx-assistant-collapse" size={16} aria-hidden="true" /><X className="mx-assistant-sheet-close" size={20} aria-hidden="true" /></Button>
      </div>
    </div>
    <ThreadPrimitive.ViewportProvider>
    <ThreadPrimitive.Viewport className="mx-assistant-transcript" ref={scroller} role="region" tabIndex={0}
      scrollToBottomOnRunStart={false} aria-label={t("对话", "Conversation")}>
      {!messages.length && <div className="mx-assistant-opening"><CardTitle card={card} />{card.status && <p role="status" className="mx-assistant-note">{card.status}</p>}<ReadingLines card={card} />
        <div className="mx-assistant-questions">{card.questions.map(q => <button tabIndex={0} key={q} disabled={sendingBlocked || readingPending} onClick={() => send(q, openingTarget)}>{q}</button>)}</div>
      </div>}
      {exchanges.length > 0 && <ol className="mx-assistant-messages" role="list">
      {exchanges.map(exchange => {
        const retainedRecord = exchange.user ? turnStore.turns[exchange.user.id] : undefined;
        const storedContext = exchange.user ? extractTurnContext(exchange.user) : null;
        const storedRequest = object(object(exchange.user?.metadata).turnContext);
        const storedPrompt = exchange.user?.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
        const expiredApproval = !retainedRecord && needsApproval(exchange.assistant);
        const record = retainedRecord ?? (exchange.user && storedPrompt && (storedContext || expiredApproval) ? {
          userMessageId: exchange.user.id, attemptId: 0, prompt: storedPrompt,
          status: expiredApproval ? "failed" as const : "completed" as const,
          ...(expiredApproval && { errorCode: "assistant_approval_expired" }),
          requestContext: { ...storedRequest, timezone: timeZone },
          turnContext: storedContext ?? {}, card: null,
        } : undefined);
        const userContext = exchange.user
          ? (record?.turnContext ?? extractTurnContext(exchange.user))
          : null;
        const userContextLabel = userContext ? formatTurnContext(userContext, locale, timeZone) : "";
        const interrupted = record && isRetryableStatus(record.status) ? record.status : null;
        const streamingTurn = record?.status === "streaming";
        const effectiveAssistant = interrupted && !expiredApproval ? (record?.frozenAssistant ?? null) : (exchange.assistant ?? null);
        const steps = extractWorkSteps(effectiveAssistant, Boolean(streamingTurn), locale, timeZone);
        const durations = exchange.user && toolDurations.get(exchange.user.id);
        const verified = !streamingTurn && !expiredApproval && effectiveAssistant
          ? verifyMessage(effectiveAssistant, locale, timeZone, Boolean(interrupted)) : [];
        const retained = streamingTurn && record.frozenAssistant
          ? verifyMessage(record.frozenAssistant, locale, timeZone, true) : [];
        const showAssistantTurn = Boolean(effectiveAssistant || record);
        const answerContext = record?.turnContext ?? resolved.turnContext;
        const followUps = answerContext.page === "research" && answerContext.lens === "technical"
          ? [t("之后的走势如何？", "What happened to the price afterwards?"), ...technicalQuestions.slice(1)]
          : (record?.card ?? card).questions.slice(0, 3);

        const branchPicker = branches && branches.userId === exchange.user?.id &&
          <div className="mx-assistant-branches" aria-label={t("回复分支", "Reply branches")} role="group">
            <Button size="icon" variant="ghost" tabIndex={0} disabled={busy || branches.selected === 0} onClick={() => chooseBranch(branches.selected - 1)} aria-label={t("上一分支", "Previous branch")}><ChevronLeft size={16} aria-hidden="true" /></Button>
            <span>{branches.selected + 1}/{branches.versions.length + 1}</span>
            <Button size="icon" variant="ghost" tabIndex={0} disabled={busy || !browsingBranch} onClick={() => chooseBranch(branches.selected + 1)} aria-label={t("下一分支", "Next branch")}><ChevronRight size={16} aria-hidden="true" /></Button>
          </div>;
        return <li key={exchange.id}>
          {exchange.user && (
            <article className="mx-assistant-turn mx-turn-user" aria-label={t("你的消息", "Your message")}>
              <div className="mx-assistant-user-bubble">{exchange.user.parts.map((p, i) => p.type === "text" ? <p key={i}>{p.text}</p> : null)}</div>
              {userContextLabel && <span className="mx-assistant-turn-context">{userContextLabel}</span>}
              {record && !browsingBranch && !interrupted && !streamingTurn && <Button variant="ghost" size="icon" tabIndex={0} className="mx-assistant-edit" disabled={busy} onClick={() => editTurnPrompt(record)} aria-label={t("编辑问题", "Edit prompt")}><Pencil size={16} aria-hidden="true" /></Button>}
            </article>
          )}
          {showAssistantTurn && (
            <article aria-label={ASSISTANT_NAME}
              className="mx-assistant-turn mx-turn-assistant"
              data-turn-status={record?.status}
            >
              {streamingTurn ? (
                <>
                  {effectiveAssistant && steps.length > 0 ? (
                    <div className="mx-assistant-work">
                      <ChatWorkSteps messageId={effectiveAssistant.id} durations={durations} />
                    </div>
                  ) : (
                    <p className="mx-assistant-note">
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
                  <WorkStepsDisclosure steps={steps} durations={durations} seconds={record ? elapsed[record.userMessageId] : undefined} />
                  {verified.length > 0 && <VerifiedLines lines={verified} />}
                  <div className="mx-assistant-turn-actions">
                    {["assistant_snapshot_missing", "assistant_approval_expired"].includes(record.errorCode ?? "") ? (
                      <button type="button" tabIndex={0} disabled={busy || !ready || pending}
                        onClick={() => retryTurn(record, true, expiredApproval && !storedContext ? resolved : record)}>
                        {t("按当前数据重试", "Retry with current data")}
                      </button>
                    ) : (
                      <>
                        <button type="button" tabIndex={0} disabled={busy || !ready || pending} onClick={() => retryTurn(record)}>
                          {t("重试", "Retry")}
                        </button>
                        <button type="button" tabIndex={0} disabled={busy} onClick={() => editTurnPrompt(record)}>
                          {t("编辑问题", "Edit prompt")}
                        </button>
                      </>
                    )}
                  </div>
                  {branchPicker}
                </>
              ) : (
                <>
                  {expiredApproval && <p className="mx-assistant-note">{turnStatusText("failed", "assistant_approval_expired", false, t)}</p>}
                  <WorkStepsDisclosure steps={steps} durations={durations} seconds={record ? elapsed[record.userMessageId] : undefined}>
                    {retainedRecord && effectiveAssistant ? <ChatWorkSteps messageId={effectiveAssistant.id} durations={durations} /> : undefined}
                  </WorkStepsDisclosure>
                  {verified.length > 0 ? <VerifiedLines lines={verified} showRecord /> : <p className="mx-assistant-note">{unverifiedNotice(t)}</p>}
                  <div className="mx-assistant-turn-actions">
                    {verified.length > 0 && <CopyButton variant="ghost" size="icon" tabIndex={0} iconOnly
                      label={t("复制回复", "Copy reply")} copiedLabel={t("已复制", "Copied")} failedLabel={t("无法复制回复", "Could not copy reply")}
                      value={verified.map(line => replyText(line, locale, timeZone, t)).join("\n")} />}
                    {record && <Button variant="ghost" size="icon" tabIndex={0} disabled={busy || sendingBlocked || browsingBranch} onClick={() => retryTurn(record)} aria-label={t("重试", "Retry")}><RotateCw size={16} aria-hidden="true" /></Button>}
                    {branchPicker}
                    {verified[0]?.evidence && (() => {
                      const href = citationPreview(verified[0].evidence, locale, timeZone)?.href;
                      if (!href?.startsWith("/")) return null;
                      const target = phone ? phoneRecordHref(href) : href;
                      return <Link className="mx-assistant-show-on-page" href={target}
                        onNavigate={() => openRecord(target)}>{t("在页面上显示", "Show on page")}</Link>;
                    })()}
                  </div>
                  {verified.length > 0 && exchange === exchanges.at(-1) && <div className="mx-assistant-questions">
                    {followUps.map(question => <button type="button" tabIndex={0} key={question} disabled={busy || sendingBlocked || browsingBranch} onClick={() => send(question, record ?? resolved)}>{question}</button>)}
                  </div>}
                </>
              )}
            </article>
          )}
        </li>;
      })}</ol>}
    </ThreadPrimitive.Viewport>
    <ThreadPrimitive.ScrollToBottom className="mx-assistant-jump" onClick={() => focusAssistantControl(scroller.current)}>
      <ArrowDown size={16} aria-hidden="true" />{t("跳到最新消息", "Jump to latest")}
    </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.ViewportProvider>
    <span data-assistant-announcement><StatusMessage message={announcement} /></span>
    <form className="mx-assistant-composer" onSubmit={event => {
      event.preventDefault();
      if ((event.nativeEvent as SubmitEvent).submitter?.hasAttribute("data-assistant-stop")) return;
      send(draft);
    }}>
      <span className="mx-assistant-scope"><ChartNoAxesCombined size={12} aria-hidden="true" />{
        checking ? t("正在检查连接…", "Checking connection…") : composerContextLabel
      }</span>
      <label htmlFor={inputId} className="sr-only">{t("消息", "Message")}</label>
      {parkedDraft && <Button variant="ghost" size="table" className="mx-assistant-restore-draft" onClick={() => {
        setParkedDraft(draft.trim() ? {text: draft, card: handoffBinding, origin: editedOrigin} : undefined);
        setDraft(parkedDraft.text);
        setHandoffBinding(parkedDraft.card);
        setEditedOrigin(parkedDraft.origin);
        setEditing(undefined);
        focusAssistantControl(textareaElement.current);
      }}>{t("恢复上一份草稿", "Restore previous draft")}</Button>}
      {editing && <div className="mx-assistant-edit-state">
        {t("编辑问题", "Editing message")}
        <Button variant="ghost" size="table" onClick={() => { setEditing(undefined); setEditedOrigin(null); }}>{t("取消编辑", "Cancel edit")}</Button>
      </div>}
      <div className="mx-assistant-input" data-value={draft}>
        <textarea id={inputId} ref={history ? null : setComposerNode} rows={1} name="message" value={draft}
          onChange={e => {
            draftRevision.current++;
            restoredFromStopRef.current = null;
            setDraft(e.target.value);
          }} maxLength={16000}
          placeholder={t("给 {name} 发消息…", "Message {name}…").replace("{name}", ASSISTANT_NAME)}
          onKeyDown={e => {
            if (e.key !== "Enter" || e.shiftKey || isImeComposing(e)) return;
            e.preventDefault();
            if (!busy && !browsingBranch && !sendingBlocked && draft.trim()) e.currentTarget.form?.requestSubmit();
          }} />
      </div>
      <div className="mx-assistant-composer-tools">
        <HoldingsPicker disabled={sendingBlocked || !open || history} onSelect={ticker => {
          draftRevision.current++;
          restoredFromStopRef.current = null;
          const field = textareaElement.current;
          const start = field?.selectionStart ?? draft.length;
          const end = field?.selectionEnd ?? start;
          const insert = (start && !/\s/.test(draft[start - 1]) ? " " : "") + "@" + ticker + " ";
          setDraft(draft.slice(0, start) + insert + draft.slice(end));
          focusAssistantControl(field);
          requestAnimationFrame(() => field?.setSelectionRange(start + insert.length, start + insert.length));
        }} />
        <span className="mx-assistant-current-model" title={model ?? undefined}>{model ?? t("模型未报告", "Model unavailable")} {model && <ChevronDown size={16} aria-hidden="true" />}</span>
        <Button className="mx-assistant-send" type={busy ? "button" : "submit"} size="icon" tabIndex={0}
          disabled={!busy && (sendingBlocked || browsingBranch || !draft.trim())}
          data-assistant-stop={busy ? "" : undefined}
          onClick={event => {
            if (!busy) return;
            // The same control becomes Send once Stop clears the run.
            event.preventDefault();
            handleStop();
          }} aria-label={busy ? t("停止", "Stop") : t("发送", "Send")}>
          {busy ? <Square size={16} aria-hidden="true" fill="currentColor" /> : <ArrowUp size={18} aria-hidden="true" />}
        </Button>
      </div>
    </form>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

type HistoryConversation = components["schemas"]["AssistantConversation"];

function History({ select, back, removed, local }: {
  select: (id: string, messages: UIMessage[]) => void; back: () => void;
  removed: (id: string) => void; local: Map<string, RetainedThread>;
}) {
  const t = useCopy();
  const {locale, timeZone} = useLocale();
  const client = useQueryClient();
  const backButton = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<"read" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const { ready } = useAssistant();
  const conversations = useQuery({
    enabled: ready, queryKey: ["assistant-conversations"],
    queryFn: ({ signal }) => readApi<HistoryConversation[]>("/assistant/conversations", signal),
    retry: false,
  });
  const action = useRef<AbortController | null>(null);
  useEffect(() => { focusAssistantControl(backButton.current); }, []);
  useEffect(() => () => action.current?.abort(), [ready]);

  async function act(id: string, erase: boolean) {
    if (!ready || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    const { signal } = controller;
    setBusy(true);
    setError(null);
    try {
      const path = "/assistant/conversations/" + encodeURIComponent(id);
      if (erase) {
        try {
          await api(path, { method: "DELETE", signal });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        if (signal.aborted) return;
        client.setQueryData<HistoryConversation[]>(["assistant-conversations"], rows => rows?.filter(row => row.id !== id));
        removed(id);
        setConfirm(null);
        focusAssistantControl(backButton.current);
        await client.invalidateQueries({ queryKey: ["assistant-conversations"] });
      } else {
        const messages = local.get(id)?.messages ?? (await readApi<{ messages: UIMessage[] }>(path, signal)).messages;
        if (!signal.aborted) select(id, messages);
      }
    } catch {
      if (!signal.aborted) setError(erase ? "delete" : "read");
    } finally {
      action.current = null;
      setBusy(false);
    }
  }

  const rows = conversations.data ?? [];
  const localRows = [...local.values()].filter(row => !rows.some(saved => saved.id === row.id)).map(row => {
    const firstPrompt = row.messages.find(message => message.role === "user")?.parts
      .filter(part => part.type === "text").map(part => part.text).join(" ");
    return {id: row.id, title: (row.draft.trim() || row.parkedDraft?.text || firstPrompt || "").slice(0, 100), updatedAt: ""};
  });
  return <>
    <div className="mx-assistant-heading">
      <strong>{t("历史对话", "Conversation history")}</strong>
      <Button size="icon" variant="ghost" tabIndex={0} data-assistant-dismiss ref={backButton} onClick={back} aria-label={t("返回对话", "Back to conversation")}><X size={18} aria-hidden="true" /></Button>
    </div>
    <div className="mx-assistant-transcript" role="region" tabIndex={0} aria-label={t("历史对话", "Conversation history")}>
      {conversations.isPending && <p role="status">{t("正在加载对话…", "Loading conversations…")}</p>}
      {conversations.isError && <div className="mx-assistant-history-error">
        <p role="alert">{t("无法读取历史对话。", "Could not load conversations.")}</p>
        <Button variant="secondary" onClick={() => void conversations.refetch()}>{t("重试", "Retry")}</Button>
      </div>}
      {error === "read" && <p role="alert">{t("无法打开这段对话。", "Could not open this conversation.")}</p>}
      {conversations.isSuccess && !rows.length && !localRows.length && <p>{t("暂无已保存的对话。", "No saved conversations yet.")}</p>}
      {[...localRows, ...rows].map(row => {
        const title = row.title || t("对话", "Conversation");
        const activity = row.updatedAt && formatDateTime(row.updatedAt, locale, timeZone);
        const target = !row.title && activity ? title + " · " + activity : title;
        return <div className="mx-assistant-history" key={row.id}>
          <Button variant="ghost" tabIndex={0} disabled={busy} onClick={() => void act(row.id, false)}>
            <span>{title}</span>
            {row.updatedAt && <time dateTime={row.updatedAt}>{activity}</time>}
          </Button>
          <Button variant="ghost" size="icon" tabIndex={0} disabled={busy} onClick={() => { setError(null); setConfirm({id: row.id, title: target}); }}
            aria-label={t("删除对话", "Delete conversation") + " · " + target}><Trash size={16} aria-hidden="true" /></Button>
        </div>;
      })}
    </div>
    {confirm && <WorkspaceAlertDialog open title={t("删除对话", "Delete conversation")} onClose={() => setConfirm(null)} hideClose
      initialFocus={() => document.querySelector<HTMLElement>("[data-assistant-cancel-delete]")} preventDismiss={busy}>
      <AlertDialogDescription>{confirm.title}</AlertDialogDescription>
      {error === "delete" && <p role="alert">{t("无法删除这段对话。", "Could not delete this conversation.")}</p>}
      <div className="mx-assistant-delete-actions">
        <Button variant="secondary" data-assistant-cancel-delete disabled={busy} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button>
        <Button variant="destructive" loading={busy} onClick={() => void act(confirm.id, true)}>{t("删除", "Delete")}</Button>
      </div>
    </WorkspaceAlertDialog>}
  </>;
}

export default function AssistantSidebar(props: SidebarProps) {
  const { handoff } = useAssistant();
  const [initial, setInitial] = useState(() => newThread(makeConversationId(), 0));
  const [retained, setRetained] = useState(() => new Map<string, RetainedThread>());
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const sequence = handoff?.sequence ?? 0;
  const history = historyAt === sequence;
  const fresh = () => setInitial(newThread(makeConversationId(), sequence));
  function remember(thread: RetainedThread) {
    setRetained(previous => {
      const next = new Map(previous);
      if (thread.draft || thread.parkedDraft || thread.messages.length) next.set(thread.id, thread);
      else next.delete(thread.id);
      return next;
    });
  }
  useEffect(() => {
    const erased = () => {
      setRetained(new Map());
      setInitial(newThread(makeConversationId(), sequence));
      setHistoryAt(null);
    };
    window.addEventListener(conversationsErasedEvent, erased);
    return () => window.removeEventListener(conversationsErasedEvent, erased);
  }, [sequence]);
  return <>
    <div className="mx-assistant-thread" hidden={history}><Thread key={initial.id} {...props} initial={initial} history={history}
      onNew={thread => { remember(thread); fresh(); }}
      onHistory={thread => { remember(thread); setHistoryAt(sequence); }} /></div>
    {history && <History back={() => setHistoryAt(null)} local={retained} select={(id, messages) => {
      if (id !== initial.id) setInitial({ ...(retained.get(id) ?? newThread(id, sequence, messages)), sequence });
      setHistoryAt(null);
    }} removed={id => {
      setRetained(previous => {
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
      if (id === initial.id) fresh();
    }} />}
  </>;
}
