"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { useCopy } from "../foundation";
import { usePerformanceBenchmark } from "./benchmark";
import { DigestRow, EvidenceLink, FollowUps } from "./cards";
import { useAssistant, usePageRole, type RoleCard } from "./context";
import { fetchReading, useRoleReading } from "./reading";

const sections = {market: ["市场", "Market"], portfolio: ["你的组合", "Your portfolio"], events: ["事件", "Events"], next: ["接下来", "Coming up"]} as const;
export function OverviewBrief({ snapshot }: { snapshot: string }) {
  const { ready } = useAssistant();
  return ready ? <Brief snapshot={snapshot} /> : null;
}
function Brief({ snapshot }: { snapshot: string }) {
  const [role, setRole] = useState<"daily" | "weekly">("daily");
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const benchmark = usePerformanceBenchmark();
  const request = useMemo(() => ({ role, context: {}, latest: true, cachedOnly: true }), [role]);
  const query = useRoleReading(request, true);
  const generate = useMutation({
    mutationFn: async () => {
      const run = new AbortController();
      controller.current = run;
      const result = await fetchReading({role, context: {}, snapshotId: snapshot}, run.signal);
      if (!run.signal.aborted && result) client.setQueryData(["assistant-reading", request], result);
      return result;
    },
  });
  useEffect(() => () => controller.current?.abort(), [role, snapshot]);
  const saved = query.data;
  const reading = useMemo(() => saved && ({...saved, lines: saved.lines.map(line => line.variants?.[benchmark] ? {...line, ...line.variants[benchmark]} : line)}), [saved, benchmark]);
  const title = role === "daily" ? t("日报", "Daily brief") : t("周报", "Weekly brief");
  const asOf = reading && new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {timeZone, month: "short", day:"numeric", hour:"2-digit", minute:"2-digit", hourCycle: "h23"}).format(new Date(reading.asOf));
  const card = useMemo<RoleCard>(() => ({
    role, title, object: t("全部投资账户", "All investment accounts"), context: {benchmark}, reading,
    questions: [t("与 {benchmark} 同期相比如何？", "How did the portfolio compare with {benchmark}?").replace("{benchmark}", benchmark),
      t("哪些持仓影响最大？", "Which holdings had the largest impact?"), t("下一份持仓财报是什么？", "Which holding reports next?")],
  }), [role, title, t, benchmark, reading]);
  usePageRole(card);
  return <DigestRow storageKey="overview" header={<div className="mx-brief-period" role="group" aria-label={t("简报周期", "Brief period")}>
    {(["daily", "weekly"] as const).map(v => <button key={v} aria-pressed={role === v} onClick={() => { if (role !== v) { generate.reset(); setRole(v); } }}>
      {v === "daily" ? t("日报", "Daily") : t("周报", "Weekly")}</button>)}</div>}
    headline={<span>{asOf ? (t("截至 ", "As of ") + asOf) : card.object}</span>}>
    {reading ? <><div className="mx-digest-grid">
      {Object.entries(sections).map(([section, label]) => <div key={section}><h4>{t(label[0], label[1])}</h4>
        {reading.lines.filter(line => line.section === section).map((line,i) => <p key={i} className="mx-reading-line">{t(line.zh,line.en)} <EvidenceLink evidence={line.evidence}/></p>)}
      </div>)}</div><FollowUps card={card} /></> : <div className="mx-brief-empty" role="status">
      <p>{generate.isPending ? t("正在读取账户、基准与持仓日历…", "Reading accounts, benchmarks and holding calendars…") :
        generate.isError || query.isError ? t("简报暂时不可用。", "The brief is unavailable.") :
        generate.isSuccess ? t("可核实的记录不足。", "There are too few verified observations.") : t("尚无已写好的简报。", "No brief has been written yet.")}</p>
      <button onClick={() => generate.isPending ? controller.current?.abort() : generate.mutate()}>{generate.isPending ? t("停止", "Stop") : t("撰写简报", "Write brief")}</button>
    </div>}
  </DigestRow>;
}
