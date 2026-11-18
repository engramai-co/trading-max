"use client";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import { object, readApi, safeUrl, str } from "../data";
import { Page, Panel, Pending, useCopy } from "../foundation";
import { useRouteState } from "../route-state";
import { renderToolField } from "./figures";
import { researchFigure } from "./research-figures";
import { sourceLabel, type Evidence } from "./evidence";

export default function CitedResearch() {
  const {params} = useRouteState();
  const {locale,timeZone} = useLocale();
  const t = useCopy();
  const ticker = params.get("ticker") || "MARKET";
  const tool = params.get("evidence") || "";
  const query = new URLSearchParams({tool});
  for (const key of ["snapshotId","series","date","start","end","evidenceId","eventId","event","index","scope","timezone","eventTicker","market","limit","cursor","reference","observation","unselected"]) {
    const value = params.get(key);
    if (value) query.set(key,value);
  }
  const url = "/research/" + encodeURIComponent(ticker) + "/citation?" + query;
  const result = useQuery({queryKey:["research-citation",url],queryFn:({signal})=>readApi<components["schemas"]["ResearchCitation"]>(url,signal),
    enabled:params.has("snapshotId"), retry:false, staleTime:0, refetchOnMount:"always"});
  const data = result.data;
  const ref: Evidence = {tool, evidenceId:params.get("evidenceId") || "", source:"market", arguments:Object.fromEntries(params)};
  const field = params.get("field");
  const figure = data && field ? researchFigure(ref,object(data.output),field,locale,timeZone) : null;
  const text = data && field ? renderToolField(tool,object(data.output),field,locale,timeZone,figure) : null;
  const story = tool === "research_headline" && data ? object(object(data.output).data) : {};
  const urlSource = safeUrl(str(story.url));
  return <Page title={t("研究","Research")}><Panel title={t("引用的研究记录","Cited research observation") + " · " + ticker}>
    {result.isFetching ? <Pending shape="chart" quiet/> : result.isError || !data || (field && !text)
      ? <p role="status">{t("引用的研究记录已不可用。","Cited research observation unavailable.")}</p>
      : text ? <p>{text} · {urlSource ? <a href={urlSource} rel="noreferrer" target="_blank">{str(story.publisher)}</a> : sourceLabel(figure?.evidence ?? ref,t)}</p>
      : data.lines?.map((line,i)=><p key={i}>{t(line.zh,line.en)} · {sourceLabel(line.evidence,t)}</p>)}
  </Panel></Page>;
}
