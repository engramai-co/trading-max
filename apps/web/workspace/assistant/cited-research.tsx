"use client";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { object, objects, readApi, safeUrl, str } from "../data";
import { Page, Panel, Pending, useCopy } from "../foundation";
import { useRouteState } from "../route-state";
import { useAssistantPageContext } from "./context";
import { renderToolField, resolveCalendarField } from "./figures";
import { researchFigure } from "./research-figures";
import { sourceLabel, type Evidence } from "./evidence";

export default function CitedResearch() {
  const {params} = useRouteState();
  const {locale,timeZone} = useLocale();
  const t = useCopy();
  const ticker = params.get("ticker") || "MARKET";
  const tool = params.get("evidence") || "";
  const company = tool === "company_profile";
  const query = new URLSearchParams({tool});
  for (const key of ["snapshotId","series","date","start","end","evidenceId","eventId","event","index","scope","timezone","eventTicker","market","limit","cursor","reference","observation","unselected"]) {
    const value = params.get(key);
    if (value) query.set(key,value);
  }
  const url = "/research/" + encodeURIComponent(ticker) + "/citation?" + query;
  const result = useQuery({queryKey:["research-citation",url],queryFn:({signal})=>readApi<components["schemas"]["ResearchCitation"]>(url,signal),
    enabled:params.has("snapshotId") && params.has("evidenceId"), retry:false, staleTime:0, refetchOnMount:"always"});
  const data = result.data;
  const ref: Evidence = {tool, evidenceId:params.get("evidenceId") || "", source:"market", arguments:Object.fromEntries(params)};
  const position = params.get("sentence") ?? "";
  const field = company ? (/^(0|[1-9]\d?)$/.test(position) ? "/data/sentences/" + position : null) : params.get("field");
  const figure = data && field ? researchFigure(ref,object(data.output),field,locale,timeZone) : null;
  const calendarTool = tool === "news_and_events" || tool === "upcoming_events";
  const calendarRow = calendarTool && field?.startsWith("/data/items/");
  const text = calendarRow ? figure?.text : data && field ? renderToolField(tool,object(data.output),field,locale,timeZone,figure) : null;
  const story = tool === "research_headline" && data ? object(object(data.output).data) : {};
  const output = object(data?.output);
  const snapshotId = str(output.snapshot_id);
  const evidenceId = str(output.evidence_id);
  const fingerprint = params.get("sentenceId");
  const values = object(output.data);
  const companySentence = company && fingerprint && figure?.evidence.arguments?.sentenceId === fingerprint && Array.isArray(values.sentences)
    ? str(values.sentences[Number(position)]) : "";
  const scope = str(output.scope);
  const validScope = ["invest", "isa", "broker_total", "cfd", "household"].includes(scope);
  const calendar = calendarRow && field ? resolveCalendarField(ref, output, field) : null;
  const chartEvent = tool === "price_key_moments" && field?.includes("/events/");
  const shown = !result.isFetching && !result.isError && data && (field ? text : data.lines?.length)
    && snapshotId === params.get("snapshotId") && evidenceId === params.get("evidenceId")
    && (!company || companySentence)
    && (!calendarTool || Boolean(calendar && validScope))
    && (!chartEvent || (params.has("eventId") && figure?.evidence.arguments?.eventId === params.get("eventId")));
  const followUp = shown && !chartEvent && !company;
  const rowIndex = /^\/data\/items\/(\d+)(?:\/|$)/.exec(field ?? "")?.[1];
  const selected = calendar?.parent ?? (rowIndex != null ? objects(values.items)[Number(rowIndex)]
    : field?.startsWith("/data/report/") ? object(values.report) : values);
  const historicalDate = tool === "news_and_events" && (calendar?.field === "date" || calendar?.field === "local_date");
  const day = str(calendar?.field === "local_date" && historicalDate ? selected?.local_date : selected?.date).slice(0, 10);
  const endDay = str(selected?.end_date).slice(0, 10);
  const instant = str(selected?.instant);
  const lens = ["research_earnings", "upcoming_events", "news_and_events"].includes(tool) ? "analyst" : "technical";
  useAssistantPageContext({
    page: "research",
    ticker: followUp ? (calendarRow ? str(selected?.ticker) || undefined : ticker !== "MARKET" ? ticker : undefined) : undefined,
    indexId: followUp && !calendarRow ? query.get("index") ?? undefined : undefined,
    scope: followUp && validScope && (calendarRow || tool === "research_position" || tool === "price_key_moments") ? scope : undefined,
    lens: followUp ? lens : undefined,
    snapshotId: followUp ? snapshotId : undefined,
    observation: followUp ? {
      kind: tool, evidenceId: calendarRow ? str(selected?.evidence_id) : evidenceId, field: calendar?.pointer ?? field ?? undefined,
      key: data?.lines?.find(line => line.evidence.arguments?.observation === query.get("observation"))?.evidence.arguments?.observation,
      date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined,
      end: /^\d{4}-\d{2}-\d{2}$/.test(endDay) && day && endDay >= day ? endDay : undefined,
      instant: calendar && !historicalDate && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(instant) && Number.isFinite(Date.parse(instant))
        ? instant : undefined,
    } : undefined,
  });
  const urlSource = safeUrl(str(story.url));
  const title = company ? t("引用的公司资料", "Cited company profile") : t("引用的研究记录", "Cited research observation");
  return <Page title={t("研究","Research")}><Panel title={title + " · " + ticker}>
    {result.isFetching ? <Pending shape="chart" quiet/> : !shown
      ? <p role="status" data-cited-research="">{t("引用的研究记录已不可用。","Cited research observation unavailable.")}</p>
      : company ? <p data-cited-research="" data-profile-sentence={position} className="mx-profile-sentence" lang="en">{companySentence}</p>
      : text ? <p data-cited-research="">{text} · {urlSource ? <a href={urlSource} rel="noreferrer" target="_blank">{str(story.publisher)}<span className="sr-only">{t("（在新标签页中打开）"," (opens in a new tab)")}</span></a> : sourceLabel(figure?.evidence ?? ref,t)}</p>
      : data.lines?.map((line,i)=><p data-cited-research={i === 0 || undefined} key={i}>{t(line.zh,line.en)} · {sourceLabel(line.evidence,t)}</p>)}
  </Panel></Page>;
}
