"use client";

import { Button } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { formatDateTimeInTimeZone } from "@/ui/formatters";
import { readApi } from "./data";
import { Empty, LoadingStatus, Page, Panel, useCopy } from "./foundation";
import { useRouteState } from "./route-state";

type PublishedEvent = components["schemas"]["UpcomingItem"];

/** Reopen a single published event even if the ticker has left the current research list. */
export function CitedResearchEvent() {
  const {params, update} = useRouteState("push");
  const {locale, timeZone} = useLocale();
  const t = useCopy();
  const ticker = params.get("ticker") ?? "";
  const snapshot = params.get("snapshotId") ?? "";
  const kind = params.get("event") === "exDividend" ? "ex_dividend" : "earnings";
  const rowId = params.get("calendarEventId");
  const researchId = params.get("eventId");
  const valid = /^[a-zA-Z0-9_-]{1,100}$/.test(snapshot) && !!ticker && !!(rowId || researchId);
  const result = useQuery({
    queryKey:["cited-research-event",snapshot,ticker,kind,rowId,researchId],
    enabled:valid, staleTime:0, gcTime:0, retry:false,
    queryFn: async ({signal}) => {
      const query = new URLSearchParams({ticker,kind});
      if (rowId) query.set("eventId", rowId);
      else if (researchId) query.set("researchEventId", researchId);
      const item = await readApi<PublishedEvent>(`/publications/${snapshot}/events/upcoming?${query}`, signal);
      return item.ticker === ticker && item.kind === kind &&
        (rowId ? item.evidence_id === rowId : item.research_event_id === researchId) ? item : null;
    },
  });
  const row = !result.isFetching && !result.isError && result.data;
  const title = kind === "earnings" ? t("财报", "Earnings") : t("除息日期", "Ex-dividend date");
  return <Page title={t("研究", "Research")}><section data-reading-event=""><Panel title={ticker + " · " + title}>
    {result.isFetching ? <LoadingStatus label={t("正在读取引用…","Loading citation…")} /> :
      row ? <><h3>{locale === "zh" ? row.title_zh : row.title_en}</h3>
        <p>{row.instant ? formatDateTimeInTimeZone(row.instant, locale, timeZone) : [...new Set([row.date, row.end_date].filter(Boolean))].join(" – ")}</p>
        <p>{row.publisher}</p></> : <Empty title={t("引用的数据版本或事件暂不可用", "Cited publication or event unavailable")} />}
    <Button variant="subtle" onClick={() => update({evidence:null,snapshotId:null,event:null,date:null,end:null,eventId:null,calendarEventId:null})}>
      {t("打开证券研究", "Open security research")}
    </Button>
  </Panel></section></Page>;
}
