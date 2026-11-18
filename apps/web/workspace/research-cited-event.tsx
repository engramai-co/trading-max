"use client";

import { useEffect, useRef } from "react";
import { Button } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { formatDateTimeInTimeZone } from "@/ui/formatters";
import { readApi } from "./data";
import { Empty, LoadingStatus, Page, Panel, useCopy } from "./foundation";
import { useRouteState } from "./route-state";

type EventPage = components["schemas"]["UpcomingReading"];

/** Reopen a single published event even if the ticker has left the current research list. */
export function CitedResearchEvent({ recorded = false }: { recorded?: boolean }) {
  const {params, update} = useRouteState("push");
  const {locale, timeZone} = useLocale();
  const t = useCopy();
  const ticker = params.get("ticker") ?? "";
  const snapshot = params.get("snapshotId") ?? "";
  const rating = recorded && ["ratings","actions"].includes(params.get("analystView") ?? "");
  const kind = rating ? "rating_change" : params.get("event") === "exDividend" ? "ex_dividend" : "earnings";
  const day = params.get("date") ?? "";
  const end = params.get("end");
  const rowId = params.get("calendarEventId");
  const researchId = params.get("eventId");
  const stamp = Date.parse(day + "T00:00:00Z");
  const valid = /^[a-zA-Z0-9_-]{1,100}$/.test(snapshot) && !!ticker && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(stamp);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!recorded) return;
    const h = section.current?.querySelector("h2");
    if (h) { h.tabIndex = -1; h.focus(); }
  }, [recorded, snapshot, rowId]);
  const result = useQuery({
    queryKey:["cited-research-event",recorded,snapshot,ticker,kind,day,end,rowId,researchId,timeZone],
    enabled:valid, staleTime:0, gcTime:0, retry:false,
    queryFn: async ({signal}) => {
      if (recorded) {
        if (!rowId || !/^ev_[0-9a-f]{16}$/.test(rowId)) return null;
        const row = await readApi<components["schemas"]["RecordedEvent"]>(
          `/publications/${snapshot}/events/recorded/${rowId}?ticker=${encodeURIComponent(ticker)}`, signal);
        return row.snapshot_id === snapshot && row.evidence_id === rowId && row.kind === kind && row.ticker === ticker ? row : null;
      }
      // The saved day belongs to the original reader. Include adjacent days for a timezone change.
      const dateAt = (offset: number) => new Date(stamp + offset * 86_400_000).toISOString().slice(0,10);
      const query = new URLSearchParams({ticker,scope:"broker_total",start:dateAt(-2),end:dateAt(2),timezone:timeZone,limit:"20"});
      let cursor: number | null = 0;
      while (cursor !== null) {
        query.set("cursor", String(cursor));
        const page: EventPage = await readApi(`/publications/${snapshot}/events/upcoming?${query}`, signal);
        if (page.snapshot_id !== snapshot) return null;
        const found = page.data?.items.find(row => row.ticker === ticker && row.kind === kind &&
          (rowId ? row.evidence_id === rowId : researchId ? row.research_event_id === researchId :
            row.date === day && (row.end_date ?? row.date) === (end ?? day)));
        if (found) return found;
        cursor = page.data?.next_cursor ?? null;
      }
      return null;
    },
  });
  const row = !result.isFetching && !result.isError && result.data;
  const title = kind === "earnings" ? t("财报", "Earnings") : t("除息日期", "Ex-dividend date");
  const heading = recorded ? rating ? t("机构行动", "Institutional actions") : t("财报事件", "Earnings events") : ticker + " · " + title;
  return <Page title={t("研究", "Research")}><section ref={section} id={recorded ? "research-" + (rating ? "actions" : "events") : undefined} data-reading-event=""><Panel title={heading}>
    {result.isFetching ? <LoadingStatus label={t("正在读取引用…","Loading citation…")} /> :
      row ? <><h3>{locale === "zh" ? row.title_zh : row.title_en}</h3>
        {recorded && <p>{ticker}{row.status === "reported" && " · " + t("已公布", "Reported")}</p>}
        {"actual_eps" in row && row.actual_eps != null && row.currency &&
          <p>{t("公布每股收益", "Reported EPS")} · {row.actual_eps} {row.currency}</p>}
        {"estimated_eps" in row && row.estimated_eps != null && row.currency &&
          <p>{t("预期每股收益", "Estimated EPS")} · {row.estimated_eps} {row.currency}</p>}
        {"firm" in row && row.firm && <p>{[row.firm, [row.from_grade, row.to_grade].filter(Boolean).join(" → ")].filter(Boolean).join(" · ")}</p>}
        <p>{row.instant ? formatDateTimeInTimeZone(row.instant, locale, timeZone) : [...new Set([row.date, "end_date" in row ? row.end_date : null].filter(Boolean))].join(" – ")}</p>
        <p>{row.publisher}</p></> : <Empty title={t("引用的数据版本或事件暂不可用", "Cited publication or event unavailable")} />}
    <Button variant="subtle" onClick={() => update({evidence:null,snapshotId:null,event:null,date:null,end:null,eventId:null,calendarEventId:null})}>
      {t("打开证券研究", "Open security research")}
    </Button>
  </Panel></section></Page>;
}
