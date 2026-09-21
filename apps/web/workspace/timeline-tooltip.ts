import { currency, percent } from "@/workspace/data";
import { numeric } from "@/lib/numeric";

export type TimelineTooltipRow = {
  label: string;
  values: Array<number | null>;
  percentage?: boolean;
  percentages?: Array<number | null>;
  signed?: boolean;
  optional?: boolean;
};

export type TimelineTooltip = {
  account?: string;
  range?: string;
  unit?: string;
  primary: TimelineTooltipRow[];
  secondary: TimelineTooltipRow[];
};

// Account names and provenance can come from providers. ECharts HTML formatters
// must treat every label as text, including labels used by local mock accounts.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export function timelineTooltipCard(
  content: TimelineTooltip,
  index: number,
  timestamp: string,
  note?: string,
) {
  const rows = (items: TimelineTooltipRow[]) => items.flatMap((row) => {
    const value = numeric(row.values[index]);
    if (value == null && row.optional) return [];
    const relative = numeric(row.percentages?.[index]);
    const formatted = row.percentage ? percent(value, true, 2) : currency(value, "GBP", 2);
    const tone = row.signed && value != null && value !== 0 ? value > 0 ? "up" : "down" : "neutral";
    return [`<div class="mx-chart-tooltip__row">
      <dt>${escapeHtml(row.label)}</dt>
      <dd data-tone="${tone}"><span>${escapeHtml(formatted)}</span>${relative == null ? "" : `<small>${escapeHtml(percent(relative, true, 2))}</small>`}</dd>
    </div>`];
  }).join("");
  const primary = rows(content.primary);
  const secondary = rows(content.secondary);
  return `<div class="mx-chart-tooltip__card">
    ${content.account || content.range || content.unit ? `<div class="mx-chart-tooltip__header">
      ${content.account ? `<span class="mx-chart-tooltip__account">${escapeHtml(content.account)}</span>` : ""}
      ${content.range ? `<strong>${escapeHtml(content.range)}</strong>` : ""}
      ${content.unit ? `<span class="mx-chart-tooltip__unit">${escapeHtml(content.unit)}</span>` : ""}
    </div>` : ""}
    <div class="mx-chart-tooltip__date">${escapeHtml(timestamp)}</div>
    ${primary ? `<dl class="mx-chart-tooltip__primary">${primary}</dl>` : ""}
    ${secondary ? `<dl class="mx-chart-tooltip__secondary">${secondary}</dl>` : ""}
    ${note ? `<div class="mx-chart-tooltip__note">${escapeHtml(note)}</div>` : ""}
  </div>`;
}
