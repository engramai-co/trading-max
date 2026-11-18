"use client";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useMemo, useRef, useState, type ComponentProps } from "react";
import type { components } from "@/lib/api-schema";
import { readApi } from "../data";
import { useCopy } from "../foundation";
import { useAssistant } from "./context";
import type { PriceObject } from "./research";
import type { MomentOverlay as Overlay } from "./key-moments";

const LazyOverlay = lazy(() => import("./key-moments").then(module => ({default: module.MomentOverlay})));
export function MomentOverlay(props: ComponentProps<typeof Overlay>) {
  return <Suspense fallback={null}><LazyOverlay {...props} /></Suspense>;
}
type CandidateResult = components["schemas"]["Reading_PriceMoments_"];
export type MomentWindow = PriceObject & { start: string; end: string };
export type NumberedMoment = { date: string; number: number };

export function useKeyMoments(security: PriceObject | null, start: string, end: string, snapshotId?: string) {
  const { ready } = useAssistant();
  const t = useCopy();
  const enabled = Boolean(ready && security && start && end && snapshotId);
  const ticker = security?.ticker, seriesId = security?.published_series_id, indexId = security?.index_id;
  const window = useMemo(() => ticker && seriesId && start && end ?
    {ticker, published_series_id: seriesId, ...(indexId ? {index_id: indexId} : {}), start, end} : null,
    [ticker, seriesId, indexId, start, end]);
  const key = JSON.stringify([snapshotId, window]);
  const result = useQuery({
    queryKey: ["assistant-reading", "research-key-moments", snapshotId, window], enabled, staleTime: Infinity, retry: false,
    queryFn: ({ signal }) => readApi<CandidateResult>(`/assistant/key-moments/${snapshotId}?` +
      new URLSearchParams({ ...window!, scope: "broker_total" }), signal),
  });
  const [selected, setSelected] = useState<{ date: string; key: string } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const data = enabled ? result.data?.data : null;
  const items = data && data.published_series_id === security?.published_series_id && data.start === start && data.end === end
    ? [...data.items].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3).map(({ date }, i) => ({ date, number: i + 1 })) : [];
  const current = selected?.key === key ? items.find(m => m.date === selected.date) : undefined;
  function open(date: string, trigger: HTMLButtonElement) {
    button.current = trigger;
    setSelected(current?.date === date ? null : { date, key });
  }
  function close() {
    setSelected(null);
    if (button.current?.isConnected) button.current.focus({ preventScroll: true });
  }
  const publication = enabled ? result.data : undefined;
  const notice = publication?.quality?.issues?.includes("listing_calendar_unavailable")
    ? t("带时间的报道无法匹配此上市地的交易日。", "Timed headlines could not be matched to this listing’s trading sessions.")
    : publication?.status === "unavailable" ? t("此上市地暂无可核实的关键时刻。", "Key moments are unavailable for this listing.") : null;
  const coverage = notice ? <p className="mx-price-caveat" role="status">{notice}</p> : null;
  return { items, current, open, close, window, snapshotId, key, coverage };
}

export type Moments = ReturnType<typeof useKeyMoments>;
