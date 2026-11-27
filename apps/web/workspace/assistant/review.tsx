"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useBreakpoint } from "@/lib/hooks";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { accountName, useWorkspaceProfile } from "../profile";
import { useCopy } from "../foundation";
import { decisionHref, type ReviewScope, type ScopedDecision } from "../review-board";
import Link from "../link";
import type { Horizon } from "../review-decisions";
import { decisionContext, isHabit, toolHorizon, toolScope, type Habit } from "../review-patterns";
import { DigestRow, EvidenceLink, FollowUps, InlineReading, ReadingLines } from "./cards";
import { type RoleCard, usePageRole } from "./context";
import { readerText, type Reading } from "./evidence";
import { fetchReading, useRoleReading, type ReadingRequest } from "./reading";

type Common = { scope: Exclude<ReviewScope, "C">; snapshot: string; horizon: Horizon; habit: Habit | null };

/** Read the cache first. A digest can be requested explicitly when its first publication is pending. */
function useReviewReading(request: ReadingRequest, digest = false) {
  const client = useQueryClient();
  const cachedRequest = useMemo(() => ({ ...request, cachedOnly: true }), [request]);
  const cached = useRoleReading(cachedRequest, true);
  const [attempt, setAttempt] = useState(digest ? 0 : 1);
  const [state, setState] = useState<"idle" | "running" | "empty" | "stopped" | "error">("idle");
  const [lines, setLines] = useState<Reading["lines"]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!attempt || cached.isPending || cached.data) return;
    const run = new AbortController();
    controller.current = run;
    void fetchReading(
      request,
      run.signal,
      () => {
        if (!run.signal.aborted) setState("running");
      },
      (partial) => {
        if (!run.signal.aborted) setLines(partial);
      },
    )
      .then((result) => {
        if (run.signal.aborted) return;
        if (result) client.setQueryData(["assistant-reading", cachedRequest], result);
        setState(result ? "idle" : "empty");
      })
      .catch(() => {
        if (!run.signal.aborted) {
          setLines([]);
          setState("error");
        }
      });
    return () => run.abort();
  }, [attempt, cached.isPending, cached.data, cachedRequest, client, request]);
  return {
    reading: cached.data,
    lines,
    state:
      state === "idle" && attempt > 0 && !cached.data
        ? "running"
        : cached.isError && state === "idle"
          ? "error"
          : state,
    start: () => {
      setLines([]);
      setState("running");
      setAttempt((n) => n + 1);
    },
    stop: () => {
      setAttempt(0);
      controller.current?.abort();
      setLines([]);
      setState("stopped");
    },
  };
}

function ReadingStatus({
  run,
  digest = false,
}: {
  run: ReturnType<typeof useReviewReading>;
  digest?: boolean;
}) {
  const t = useCopy();
  const busy = run.state === "running";
  const text = busy
    ? digest
      ? t("正在读取买卖和持仓记录…", "Reading trades and holding records…")
      : t("正在读取成交、事件与同期行情…", "Reading the trade, dated events and matched prices…")
    : run.state === "stopped"
      ? t("已停止解读。", "Reading stopped.")
      : run.state === "error"
        ? t("暂时无法读取。", "The reading is unavailable.")
        : run.state === "empty"
          ? t("可核实的记录不足。", "There are too few verified records.")
          : digest
            ? t("尚无已写好的习惯。", "No habits brief has been written yet.")
            : t("正在读取复盘…", "Loading review…");
  return (
    <div className="mx-brief-empty">
      <p role="status">{text}</p>
      <button type="button" onClick={busy ? run.stop : run.start}>
        {busy
          ? t("停止", "Stop")
          : digest && run.state === "idle"
            ? t("撰写习惯", "Write brief")
            : t("重试", "Retry")}
      </button>
    </div>
  );
}

export function ReviewHabits({
  scope,
  snapshot,
  horizon,
  habit,
  active,
  onSelect,
}: Common & { active: boolean; onSelect: (habit: Habit | null, options: { focusFilter: boolean; citation?: boolean }) => void }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const phone = useBreakpoint("phone");
  const [sheet, setSheet] = useState(() => {
    try {
      return localStorage.getItem("tm-reading-review-habits-phone") === "open";
    } catch {
      return false;
    }
  });
  const showSheet = (value: boolean) => {
    setSheet(value);
    try {
      localStorage.setItem("tm-reading-review-habits-phone", value ? "open" : "closed");
    } catch {}
  };
  const opener = useRef<HTMLButtonElement>(null);
  const request = useMemo(
    () => ({ role: "habits", context: { scope: toolScope(scope) }, snapshotId: snapshot }),
    [scope, snapshot],
  );
  const run = useReviewReading(request, true);
  const saved = run.reading;
  const reading = useMemo(
    () =>
      saved && {
        ...saved,
        lines: saved.lines.map((line) =>
          horizon === "date" && line.variants?.to_date ? { ...line, ...line.variants.to_date } : line,
        ),
      },
    [saved, horizon],
  );
  const card = useMemo<RoleCard>(
    () => ({
      role: "habits",
      title: t("习惯", "Habits"),
      object: scope === "all" ? t("全部投资账户", "All investment accounts") : accountName(profile, scope),
      context: { scope: toolScope(scope), horizon: toolHorizon(horizon), habit },
      reading,
      origin: {
        page: "review",
        search: new URLSearchParams({
          account: scope,
          reviewWindow: toolHorizon(horizon), snapshotId: snapshot,
          ...(habit ? { habit } : {}),
        }).toString(),
        snapshotId: snapshot,
      },
      questions: [
        t("这个习惯出现过多少次？", "How often did this habit occur?"),
        t("换个复盘区间会怎样？", "How does the other horizon compare?"),
        t("错过的金额怎么算？", "How is the missed amount measured?"),
      ],
    }),
    [scope, horizon, habit, profile, t, reading, snapshot],
  );
  usePageRole(active ? card : null);
  const rows = reading ? (
    <div className="mx-habit-list">
      {reading.lines.map((line) => {
        const key = line.section;
        if (!isHabit(key)) return null;
        return (
          <div key={key} className="mx-habit-line" data-selected={key === habit || undefined}>
            <button
              type="button"
              aria-pressed={key === habit}
              onClick={() => {
                showSheet(false);
                const next = key === habit ? null : key;
                onSelect(next, { focusFilter: Boolean(phone && next) });
                if (phone && !next) opener.current?.focus();
              }}
            >
              {readerText(line, locale, timeZone)}
              <ChevronRight aria-hidden="true" size={16} />
            </button>
            <EvidenceLink evidence={line.evidence} onNavigate={phone ? event => {
              event.preventDefault();
              showSheet(false);
              onSelect(key, { focusFilter: true, citation: true });
            } : undefined} />
          </div>
        );
      })}
    </div>
  ) : (
    <ReadingStatus run={run} digest />
  );
  if (phone)
    return (
      <>
        <button
          className="mx-digest mx-phone-habits"
          ref={opener}
          onClick={() => showSheet(true)}
          aria-expanded={sheet}
        >
          <span aria-hidden="true">✦</span>
          <span className="mx-phone-habits-label">
            <span><strong>{card.title}</strong> · {card.object}</span>
            <span className="mx-digest-summary">{reading?.lines[0] && readerText(reading.lines[0], locale, timeZone)}</span>
          </span>
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        {sheet && (
          <InlineReading
            card={card}
            onClose={() => {
              showSheet(false);
              opener.current?.focus();
            }}
          >
            {rows}
          </InlineReading>
        )}
      </>
    );
  return (
    <DigestRow
      storageKey="review-habits"
      header={<strong>{card.title}</strong>}
      headline={card.object}
      summary={reading?.lines[0] && readerText(reading.lines[0], locale, timeZone)}
    >
      {rows}
      {reading && <FollowUps card={card} />}
    </DigestRow>
  );
}

export function DecisionReading({
  scope,
  snapshot,
  horizon,
  habit,
  row,
  onClose,
}: Common & { row: ScopedDecision; onClose: () => void }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const context = useMemo(
    () => decisionContext(row, scope, horizon, habit),
    [row, scope, horizon, habit],
  );
  const request = useMemo(() => ({ role: "decision", context, snapshotId: snapshot }), [context, snapshot]);
  const run = useReviewReading(request);
  const card = useMemo<RoleCard>(
    () => ({
      role: "decision",
      title: t("复盘", "Review"),
      object: row.ticker + " · " + formatCalendarDate(row.date, locale),
      context,
      reading: run.reading,
      origin: {
        page: "review",
        search: new URLSearchParams({
          account: row.account,
          decision: [row.date, row.side, row.ticker].join("."),
          reviewOrdinal: String(context.ordinal),
          reviewWindow: context.horizon, snapshotId: snapshot,
          ...(habit ? { habit } : {}),
        }).toString(),
        snapshotId: snapshot,
      },
      questions: [
        t("成交前有哪些记录？", "What was known before the trade?"),
        t("同期标普 500 表现如何？", "How did the S&P 500 do over the same window?"),
        t("和事后最佳时点差多少？", "What was the hindsight timing gap?"),
      ],
    }),
    [t, locale, row.ticker, row.date, row.account, row.side, context, run.reading, habit, snapshot],
  );
  usePageRole(card);
  return (
    <InlineReading card={card} onClose={onClose}>
      {run.reading ? (
        <ReadingLines card={card} />
      ) : (
        <>
          {run.lines.map((line) => (
            <p key={line.section} className="mx-reading-line">
              {readerText(line, locale, timeZone)} <EvidenceLink evidence={line.evidence} />
            </p>
          ))}
          <ReadingStatus run={run} />
          {(run.state === "error" || run.state === "empty") && (
            <Link className="mx-text-link" href={decisionHref(row.account, row, {snapshot, horizon, habit})} onNavigate={onClose}>
              {t("查看这笔决定", "View this decision")} →
            </Link>
          )}
        </>
      )}
    </InlineReading>
  );
}
