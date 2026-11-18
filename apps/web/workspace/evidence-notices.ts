import type { components } from "@/lib/api-schema";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { api, jsonRequest } from "@/workspace/data";
import { fixed, plainPercent } from "./reading-format";

export type EvidenceNotices = components["schemas"]["EvidenceNotices"];
export type EvidenceNotice = components["schemas"]["EvidenceNotice"];
type Item = components["schemas"]["EvidenceNoticeItem"];
type Copy = (zh: string, en: string) => string;

const periodKinds = { ttm: ["过去十二个月", "TTM"], annual: ["财年", "FY"], quarterly: ["季度", "Quarter"] } as const;

/** A statement period from its identity, such as "ttm:2026-03-31". */
export function periodText(id: string | null | undefined, locale: Locale) {
  if (!id) return "—";
  const [kind, end] = id.split(":");
  const [zh, en] = periodKinds[kind as keyof typeof periodKinds] ?? [kind, kind];
  const day = formatCalendarDate(end, locale);
  return locale === "zh" ? `${zh} 截至 ${day}` : `${en} to ${day}`;
}

/** Notices are derived locally on request; Settings turns them on. */
export const evidenceNoticesQuery = queryOptions({
  queryKey: ["evidence-notices"],
  queryFn: ({ signal }) => api<EvidenceNotices>("/valuation/evidence-notices", { signal }),
  staleTime: 60_000,
  retry: 1,
});

/** The notice on a security's newest saved valuation while its evidence is unopened. */
export function useEvidenceNotice(ticker: string | null | undefined): EvidenceNotice | undefined {
  const { data } = useQuery(evidenceNoticesQuery);
  const key = ticker?.toUpperCase();
  return key ? data?.notices?.find((notice) => notice.ticker === key) : undefined;
}

/** Opening the evidence settles its notice, so the same evidence is not announced again. */
export function useEvidenceSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (notice: EvidenceNotice) =>
      api<EvidenceNotices>(
        `/valuation/evidence-notices/${encodeURIComponent(notice.ticker)}/seen`,
        jsonRequest("POST", { modelId: notice.modelId, keys: notice.items.map((item) => item.key) }),
      ),
    onSuccess: (notices) => client.setQueryData(evidenceNoticesQuery.queryKey, notices),
  });
}

const kindNames = { statements: ["新报表", "New statements"], restatement: ["重述", "Restatement"] } as const;

function itemName(item: Item, t: Copy) {
  if (item.kind !== "estimate") {
    const [zh, en] = kindNames[item.kind];
    return t(zh, en);
  }
  return item.metric === "consensusEps" ? t("EPS 一致预期", "EPS consensus") : t("营收增长一致预期", "Revenue-growth consensus");
}

/** The kinds of new evidence, each once: 新报表、EPS 一致预期. */
export function noticeKinds(notice: EvidenceNotice, t: Copy) {
  return [...new Set(notice.items.map((item) => itemName(item, t)))].join(t("、", ", "));
}

/** One piece of new evidence: 新报表 · 过去十二个月 截至 2026年3月31日, or a consensus before and now. */
export function noticeLine(item: Item, t: Copy, locale: Locale) {
  if (item.kind !== "estimate") return itemName(item, t) + " · " + periodText(item.periodId, locale);
  const eps = item.metric === "consensusEps";
  const value = (figure: number | null | undefined) => (eps ? fixed(figure, 2) : plainPercent(figure, 1));
  return itemName(item, t) + " · " + t("财年 ", "FY ") + formatCalendarDate(item.periodEnd, locale) + " · " +
    value(item.saved) + " → " + value(item.current) + (eps && item.currency ? " " + item.currency : "");
}
