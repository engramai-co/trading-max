"use client";

import { citedEventKind } from "@/lib/cited-calendar-event";
import { useEffect, useRef } from "react";
import { Button } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { formatDateTimeInTimeZone } from "@/ui/formatters";
import { readApi } from "./data";
import { Empty, LoadingStatus, Page, Panel, useCopy } from "./foundation";
import { useRouteState } from "./route-state";

type PublishedEvent = components["schemas"]["CitedHoldingEvent"];

/** Reopen a single published event even if the ticker has left the current research list. */
export function CitedResearchEvent({ recorded = false }: { recorded?: boolean }) {
  const {params, update} = useRouteState("push");
  const {locale, timeZone} = useLocale();
  const t = useCopy();
  const ticker = params.get("ticker") ?? "";
  const snapshot = params.get("snapshotId") ?? "";
  const rating = recorded && ["ratings","actions"].includes(params.get("analystView") ?? "");
  const kind = rating ? "rating_change" : recorded ? "earnings" : citedEventKind(params.get("event"));
  const rowId = params.get("calendarEventId");
  const researchId = recorded ? null : params.get("eventId");
  const valid = /^[a-zA-Z0-9_-]{1,100}$/.test(snapshot) && !!kind && !!ticker && !!(rowId || researchId);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!recorded) return;
    const h = section.current?.querySelector("h2");
    if (h) { h.tabIndex = -1; h.focus(); }
  }, [recorded, snapshot, rowId]);
  const result = useQuery({
    queryKey:["cited-research-event",snapshot,ticker,kind,rowId,researchId],
    enabled:valid, staleTime:0, gcTime:0, retry:false,
    queryFn: async ({signal}) => {
      if (!kind) return null;
      const query = new URLSearchParams({ticker,kind});
      if (rowId) query.set("eventId", rowId);
      else if (researchId) query.set("researchEventId", researchId);
      const item = await readApi<PublishedEvent>(`/publications/${snapshot}/events/upcoming?${query}`, signal);
      return item.ticker === ticker && item.kind === kind &&
        (rowId ? item.evidence_id === rowId : item.research_event_id === researchId) ? item : null;
    },
  });
  const row = !result.isFetching && !result.isError && result.data;
  const title = kind === "earnings" ? t("财报", "Earnings") : kind === "ex_dividend" ? t("除息日期", "Ex-dividend date") : t("股息", "Dividend");
  const heading = recorded ? rating ? t("机构行动", "Institutional actions") : t("财报事件", "Earnings events") : ticker + " · " + title;
  return <Page title={t("研究", "Research")}><section ref={section} id={recorded ? "research-" + (rating ? "actions" : "events") : undefined} data-reading-event=""><Panel title={heading}>
    {result.isFetching ? <LoadingStatus label={t("正在读取引用…","Loading citation…")} /> :
      row ? <><h3>{locale === "zh" ? row.title_zh : row.title_en}</h3>
        {recorded && <p>{ticker}{row.status === "reported" && " · " + t("已公布", "Reported")}</p>}
        {row.actual_eps != null && row.currency &&
          <p>{t("公布每股收益", "Reported EPS")} · {row.actual_eps} {row.currency}</p>}
        {row.estimated_eps != null && row.currency &&
          <p>{t("预期每股收益", "Estimated EPS")} · {row.estimated_eps} {row.currency}</p>}
        {row.firm && <p>{[row.firm, [row.from_grade, row.to_grade].filter(Boolean).join(" → ")].filter(Boolean).join(" · ")}</p>}
        <p>{row.instant ? formatDateTimeInTimeZone(row.instant, locale, timeZone) : [...new Set([row.date, row.end_date].filter(Boolean))].join(" – ")}</p>
        <p>{row.publisher}</p></> : <Empty title={t("引用的数据版本或事件暂不可用", "Cited publication or event unavailable")} />}
    <Button variant="subtle" onClick={() => update({evidence:null,snapshotId:null,event:null,date:null,end:null,eventId:null,calendarEventId:null})}>
      {t("打开证券研究", "Open security research")}
    </Button>
  </Panel></section></Page>;
}
