"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useCopy } from "../foundation";
import { AnchoredReading, EvidenceLink, InlineReading } from "./cards";
import { useAssistant, usePageRole, type RoleCard } from "./context";
import { useRoleReading } from "./reading";
import "./inspection.css";

const descriptions = {
  exposure: {
    title: ["敞口", "Exposure"], source: ["正在读取穿透配置与历史权重…", "Reading allocation and historical weights…"],
    questions: [["占比怎样变化？","How has the weight changed?"],["与基准相差多少？","How does it compare with the benchmark?"],["哪些资产未穿透？","Which assets are unresolved?"]],
  },
  attribution: {
    title:["归因","Attribution"], source:["正在读取每日回报、基准与汇率拆分…","Reading daily returns, benchmarks and currency effects…"],
    questions:[["哪天的变动最大？","Which day moved most?"],["汇率影响多少？","What was the currency effect?"],["与所选基准相比如何？","How did the portfolio compare with the selected benchmark?"]],
  },
  "market-sector": {
    title:["盘面","Market moves"], source:["正在读取板块行情与同期报道…","Reading sector quotes and dated reporting…"],
    questions:[["涨跌集中在哪些成分？","Which constituents moved most?"],["我的敞口是多少？","What is my exposure?"],["有哪些同期报道？","What was reported during the session?"]],
  },
  "market-map": {
    title:["盘面","Market moves"], source:["正在读取全球行情与市场贡献…","Reading global quotes and market contributions…"],
    questions:[["对全球指数影响多大？","What was the contribution to the global index?"],["采用了哪天的权重？","Which weights were used?"],["哪些市场还没开盘？","Which markets had yet to open?"]],
  },
  diagnosis: {
    title:["排障","Diagnosis"], source:["正在读取更新记录…","Reading the update record…"],
    questions:[["哪些步骤已完成？","Which steps completed?"],["哪些数据受影响？","Which data is affected?"],["上次成功更新是什么时候？","When was the last successful update?"]],
  },
} as const;

export type InspectionKind = keyof typeof descriptions;
export type InspectionProps = {
  role: InspectionKind; object: string; context?: Record<string, string>; snapshotId?: string;
  onClose?: () => void; anchored?: boolean; market?: string; showMapLine?: boolean; portal?: HTMLElement | null;
};

export function Inspection({role, object, context, snapshotId, onClose, anchored, market, showMapLine, portal}: InspectionProps) {
  const t = useCopy();
  const {continueInSidebar} = useAssistant();
  const descriptor = descriptions[role];
  const identity = JSON.stringify(context ?? {});
  const request = useMemo(() => ({role, context: JSON.parse(identity) as Record<string,string>, snapshotId}), [role, identity, snapshotId]);
  const key = JSON.stringify(request);
  const [stopped, setStopped] = useState("");
  const [closed, setClosed] = useState("");
  const activeObject = JSON.stringify([role,Object.entries(request.context).filter(([field]) => field!=="observed")]);
  const [pinned, setPinned] = useState({object:activeObject,key});
  if (pinned.object!==activeObject) setPinned({object:activeObject,key});
  const updated = pinned.object===activeObject && pinned.key!==key;
  const query = useRoleReading(request, Boolean(context) && !updated && stopped !== key && closed !== key);
  const client = useQueryClient();
  const reading = useMemo(() => {
    if (role !== "market-map") return query.data;
    if (!market || !query.data || !showMapLine) return null;
    const lines = query.data.lines.flatMap(line => line.variants?.[market] ? [{...line,...line.variants[market]}] : []);
    return lines.length ? {...query.data, lines: lines.slice(0,1)} : null;
  },[role, market, query.data, showMapLine]);
  const hasContext = Boolean(context);
  const page = {exposure:"holdings",attribution:"analytics",diagnosis:"health","market-sector":"sectors","market-map":"sectors"}[role];
  const origin = useMemo(() => ({page,search:new URLSearchParams(request.context).toString(),snapshotId:snapshotId ?? reading?.snapshotId ?? undefined}), [page, request, snapshotId, reading?.snapshotId]);
  const card = useMemo<RoleCard>(() => ({
    role:hasContext && origin.snapshotId ? role : "", origin, title:t(descriptor.title[0],descriptor.title[1]), object, context:role === "market-map" && market ? {...request.context,market} : request.context, reading,
    questions:descriptor.questions.map(([zh,en]) => t(zh,en)),
  }), [hasContext, role, descriptor, object, request, reading, market, origin, t]);
  usePageRole(card);
  if (!context) return null;
  if (role === "market-map") {
    const line = reading?.lines[0];
    return portal && line ? createPortal(<div className="mx-map-reading"><p><span aria-hidden="true">✦ </span>{t(line.zh,line.en)} <EvidenceLink evidence={line.evidence}/></p>
      <button type="button" onClick={() => continueInSidebar(card)}>{t("解读 →","Read more →")}</button></div>,portal) : null;
  }
  if (updated) return <button type="button" className="mx-text-link" onClick={() => setPinned({object:activeObject,key})}>{t("解读最新记录","Read updated records")}</button>;
  if (closed === key) return <button type="button" className="mx-text-link" onClick={() => setClosed("")}>✦ {card.title}</button>;
  const close = () => { if (onClose) onClose(); else setClosed(key); };
  const Container = anchored ? AnchoredReading : InlineReading;
  return <Container card={card} onClose={close}>{!reading ? <div className="mx-inspection-status" role="status">
    <span>{query.isFetching ? t(descriptor.source[0],descriptor.source[1]) : stopped===key ? t("已停止。","Stopped.") : query.isError ? t("暂时无法读取。","Reading unavailable.") : t("可核实的记录不足。","Too few verified observations.")}</span>
    {query.isFetching ? <button onClick={() => { setStopped(key); void client.cancelQueries({queryKey:["assistant-reading",request],exact:true}); }}>{t("停止","Stop")}</button>
    : <button onClick={() => {setStopped(""); void query.refetch();}}>{t("重试","Retry")}</button>}
  </div> : undefined}</Container>;
}
