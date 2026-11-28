import type { FinishReason, UIMessage } from "ai";
import type { Locale } from "@/components/locale-provider";
import type { useCopy } from "../foundation";
import type { RoleCard } from "./context";
import { verifiedLines } from "./chat-reply";
import { displayTurns } from "./evidence";
import { errorLabel } from "./status-label";
import type { TurnContext } from "./turn-context";

export type TurnStatus =
  | "streaming"
  | "completed"
  | "stopped"
  | "failed"
  | "disconnected"
  | "rate_limited";

type InterruptedStatus = Exclude<TurnStatus, "streaming" | "completed">;

export type TurnRecord = {
  userMessageId: string;
  attemptId: number;
  prompt: string;
  requestContext: Record<string, unknown>;
  turnContext: TurnContext;
  card: RoleCard | null;
  status: TurnStatus;
  errorCode?: string;
  frozenAssistant?: UIMessage | null;
};

export type TurnStore = {
  active: { userMessageId: string; attemptId: number } | null;
  turns: Record<string, TurnRecord>;
};

export type TurnAnnouncement =
  | { kind: "completed"; subjects?: readonly string[] }
  | { kind: "stopped" }
  | { kind: "failed"; status: "failed" | "disconnected" | "rate_limited"; errorCode?: string };

export type ConversationExchange = {
  id: string;
  user?: UIMessage;
  assistant?: UIMessage;
};

export const INITIAL_TURN_STORE: TurnStore = {
  active: null,
  turns: {},
};

export function isRetryableStatus(status: TurnStatus): status is InterruptedStatus {
  return (
    status === "stopped" ||
    status === "failed" ||
    status === "disconnected" ||
    status === "rate_limited"
  );
}

export function failureCode(message: string, httpStatus?: number): string {
  try {
    const code = JSON.parse(message).detail?.code;
    if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {
    // Non-JSON error bodies use the HTTP status fallback.
  }
  if (/^[a-z_]{1,64}$/.test(message) && (httpStatus ?? 200) < 400) return message;
  if (httpStatus === 429) return "provider_rate_limited";
  if (httpStatus === 409) return "assistant_busy";
  return "assistant_unavailable";
}

export function withoutPublication<T extends { snapshotId?: unknown; role?: unknown; object?: unknown; observation?: unknown }>(context: T): T {
  const current = { ...context };
  delete current.snapshotId;
  delete current.role;
  delete current.object;
  delete current.observation;
  return current;
}

function cloneMessage(message: UIMessage | null | undefined): UIMessage | null {
  if (!message) return null;
  try {
    return structuredClone(message);
  } catch {
    return {
      ...message,
      parts: message.parts.map((part) => ({ ...part })),
    };
  }
}

export function beginTurnAttempt(
  store: TurnStore,
  params: {
    userMessageId: string;
    attemptId: number;
    prompt: string;
    requestContext: Record<string, unknown>;
    turnContext: TurnContext;
    card: RoleCard | null;
    frozenAssistant?: UIMessage | null;
  },
): TurnStore {
  return {
    active: { userMessageId: params.userMessageId, attemptId: params.attemptId },
    turns: {
      ...store.turns,
      [params.userMessageId]: {
        userMessageId: params.userMessageId,
        attemptId: params.attemptId,
        prompt: params.prompt,
        requestContext: params.requestContext,
        turnContext: params.turnContext,
        card: params.card,
        frozenAssistant: params.frozenAssistant,
        status: "streaming",
      },
    },
  };
}

function finishTurn(
  store: TurnStore,
  attemptId: number,
  announcement: TurnAnnouncement,
  message?: UIMessage | null,
  snapshotId?: string,
) {
  if (store.active?.attemptId !== attemptId) return { store, announcement: null };
  const { userMessageId } = store.active;
  const record = store.turns[userMessageId];
  const previous = record.frozenAssistant;
  return {
    store: {
      active: null,
      turns: {
        ...store.turns,
        [userMessageId]: {
          ...record,
          ...(snapshotId ? {
            requestContext: { ...record.requestContext, snapshotId },
            turnContext: { ...record.turnContext, snapshotId },
          } : {}),
          status: announcement.kind === "failed" ? announcement.status : announcement.kind,
          errorCode: announcement.kind === "failed" ? announcement.errorCode : undefined,
          frozenAssistant: announcement.kind === "completed"
            ? undefined
            : previous ?? cloneMessage(message),
        },
      },
    },
    announcement,
  };
}

export function stopTurnAttempt(store: TurnStore, attemptId: number, message?: UIMessage | null, snapshotId?: string) {
  return finishTurn(store, attemptId, { kind: "stopped" }, message, snapshotId);
}

export function settleTurnAttempt(
  store: TurnStore,
  {
    attemptId, assistantMessage, isAbort, isDisconnect, isError, sawFinish, sawAbort, finishReason, errorCode, snapshotId,
    locale = "en", timeZone = "Europe/London",
  }: {
    attemptId: number;
    assistantMessage: UIMessage | null;
    isAbort: boolean;
    isDisconnect: boolean;
    isError: boolean;
    sawFinish: boolean;
    sawAbort: boolean;
    finishReason?: FinishReason;
    errorCode?: string;
    snapshotId?: string;
    locale?: Locale;
    timeZone?: string;
  },
) {
  if (store.active?.attemptId !== attemptId) return { store, announcement: null };
  if (isAbort || sawAbort) return stopTurnAttempt(store, attemptId, assistantMessage, snapshotId);
  let announcement: TurnAnnouncement;
  if (isDisconnect || (!isError && !sawFinish)) {
    announcement = { kind: "failed", status: "disconnected" };
  } else if (isError || finishReason === "error" || finishReason === "length" || finishReason === "content-filter") {
    const status = errorCode === "provider_rate_limited" || errorCode === "assistant_busy" ? "rate_limited" : "failed";
    announcement = { kind: "failed", status, errorCode };
  } else {
    const lines = assistantMessage ? verifiedLines(assistantMessage, locale, timeZone) : [];
    if (!lines.length) {
      return finishTurn(store, attemptId, { kind: "failed", status: "failed", errorCode: "assistant_reply_unverified" },
        null, snapshotId);
    }
    const subjects = [...new Set(lines.flatMap(line => line.datedSubject ? [line.datedSubject.subject] : []))];
    announcement = { kind: "completed", ...(subjects.length > 0 && {subjects}) };
  }
  return finishTurn(store, attemptId, announcement, assistantMessage, snapshotId);
}

/** Restore the submitted prompt only when the composer is still untouched. */
export function shouldRestoreDraftOnStop(currentDraft: string, edited = false): boolean {
  return !edited && currentDraft.length === 0;
}

/** Group consecutive assistant parts with their preceding user turn. */
export function pairConversationTurns(messages: UIMessage[]): ConversationExchange[] {
  const turns = displayTurns(messages);
  const exchanges: ConversationExchange[] = [];
  for (const message of turns) {
    if (message.role === "user") {
      exchanges.push({ id: message.id, user: message });
    } else if (message.role === "assistant") {
      const last = exchanges.at(-1);
      if (last && last.user && !last.assistant) {
        last.assistant = message;
      } else {
        exchanges.push({ id: message.id, assistant: message });
      }
    }
  }
  return exchanges;
}

export function assistantMessageForUserTurn(
  messages: UIMessage[],
  userMessageId: string,
): UIMessage | null {
  const match = pairConversationTurns(messages).find((item) => item.user?.id === userMessageId);
  return match?.assistant ?? null;
}

export function turnStatusText(
  status: InterruptedStatus,
  errorCode: string | undefined,
  hasVerifiedContent: boolean,
  t: ReturnType<typeof useCopy>,
): string {
  if (status === "stopped") {
    return hasVerifiedContent
      ? t("已停止 · 仅保留已核实内容", "Stopped · Verified content kept")
      : t("已停止", "Stopped");
  }
  if (status === "disconnected") {
    return t("连接已中断。", "Connection lost.");
  }
  if (status === "rate_limited") {
    return errorLabel(errorCode ?? "provider_rate_limited", t);
  }
  if (errorCode === "assistant_snapshot_missing") {
    return t("原始数据已不可用。", "The original data is no longer available.");
  }
  if (errorCode === "assistant_approval_expired") {
    return t("工具确认已过期。", "Tool approval expired.");
  }
  if (errorCode === "assistant_reply_unverified") {
    return t("无法核实这次回复。", "This reply could not be verified.");
  }
  return errorLabel(errorCode ?? "assistant_unavailable", t);
}

export function turnAnnouncementText(event: TurnAnnouncement, t: ReturnType<typeof useCopy>): string {
  if (event.kind === "stopped") return t("已停止生成。", "Generation stopped.");
  if (event.kind === "failed") return turnStatusText(event.status, event.errorCode, false, t);
  if (event.subjects?.length) return t("{subjects} 的回复已就绪。", "Response ready for {subjects}.")
    .replace("{subjects}", event.subjects.join(t("、", ", ")));
  return t("回复已就绪。", "Response ready.");
}
