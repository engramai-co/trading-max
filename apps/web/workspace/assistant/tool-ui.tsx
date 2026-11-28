"use client";

import {
  defineToolkit, MessagePrimitive, ThreadPrimitive, useAuiState, type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Check, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { number, object, str } from "../data";
import { useCopy } from "../foundation";
import { useAssistant } from "./context";
import { stepStatusLabel, toolStepDetail, toolStepLabel, WORK_TOOL_NAMES, type WorkStepStatus } from "./work-steps";

export const workToolkit = defineToolkit(Object.fromEntries(WORK_TOOL_NAMES.map(name => [
  name,
  {type: "backend" as const, render: ToolStep},
])));

const ObservedToolTimes = createContext<ReadonlyMap<string, number> | undefined>(undefined);

export function ChatWorkSteps({messageId, durations}: {messageId: string; durations?: ReadonlyMap<string, number>}) {
  const index = useAuiState(state => state.thread.messages.findIndex(message => message.id === messageId));
  if (index < 0) return null;
  return <ol className="mx-assistant-step-list" role="list">
    <ObservedToolTimes.Provider value={durations}>
      <ThreadPrimitive.MessageByIndex index={index} components={workMessageComponents} />
    </ObservedToolTimes.Provider>
  </ol>;
}

const workMessageComponents = { AssistantMessage: WorkParts, UserMessage: () => null };
function WorkParts() {
  return <MessagePrimitive.Parts>{({part}) => part.type === "tool-call"
    ? part.toolUI ?? <ToolStep {...part} />
    : <></>}</MessagePrimitive.Parts>;
}
const stepIcons = {running: LoaderCircle, complete: Check, unavailable: CircleAlert};

function ToolStep({toolCallId, toolName, args, result, status, isError, timing, approval, respondToApproval}: ToolCallMessagePartProps) {
  const {locale, timeZone} = useLocale();
  const observed = useContext(ObservedToolTimes);
  const t = useCopy();
  const output = object(result);
  const detail = toolStepDetail(args, result, locale, timeZone);
  const state: WorkStepStatus = isError || ["unavailable", "not_applicable", "error"].includes(str(output.status))
    ? "unavailable" : status.type === "running" ? "running" : status.type === "complete" ? "complete" : "unavailable";
  const awaitingApproval = Boolean(approval && approval.approved === undefined && !approval.resolution);
  const Icon = awaitingApproval ? Circle : stepIcons[state];
  const duration = !awaitingApproval && state !== "running"
    ? timing?.completedAt != null ? Math.max(0, timing.completedAt - timing.startedAt) : observed?.get(toolCallId)
    : undefined;

  return <li data-step-status={state}>
    <Icon size={16} aria-hidden="true" />
    <span>{toolStepLabel(toolName, locale)}{detail && <small>{detail}</small>}</span>
    {awaitingApproval && approval
      ? <ToolConfirmation title={approval.prompt || t("确认运行工具", "Confirm tool run")} respond={respondToApproval} />
      : <span className="mx-assistant-step-status">{stepStatusLabel(state, locale)}
          {duration !== undefined && " · " + number(duration / 1000, 1) + t(" 秒", " s")}</span>}
  </li>;
}

function ToolConfirmation({title, respond}: {title: string; respond: ToolCallMessagePartProps["respondToApproval"]}) {
  const t = useCopy();
  const {ready, pending: checking} = useAssistant();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function answer(approved: boolean) {
    setPending(true);
    setFailed(false);
    try { await respond({approved}); }
    catch { setFailed(true); }
    finally { setPending(false); }
  }
  return <div className="mx-assistant-tool-confirm">
    <p>{title}</p>
    <Button variant="secondary" disabled={pending || checking || !ready} onClick={() => void answer(false)}>{t("拒绝", "Decline")}</Button>
    <Button disabled={pending || checking || !ready} onClick={() => void answer(true)}>{t("确认", "Confirm")}</Button>
    {failed && <p role="alert">{t("无法提交确认。", "Could not send your decision.")}</p>}
  </div>;
}
