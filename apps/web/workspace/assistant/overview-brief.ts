import type { Scope } from "@/lib/portfolio/nav";

/** Keep the household brief's scope visible beside its timestamp when the page filters to one account. */
export function overviewBriefHeadline({
  scope,
  objectLabel,
  asOfLabel,
}: {
  scope: Scope;
  objectLabel: string;
  asOfLabel?: string | null;
}): string {
  if (!asOfLabel) return objectLabel;
  return scope === "total" ? asOfLabel : `${objectLabel} · ${asOfLabel}`;
}
