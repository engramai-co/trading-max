import type { ECharts } from "echarts";

export type ChartRecord = {
  time: string;
  zone: string;
  currency: string;
  basis: string;
  source: string;
  gapType?: string;
  series: string;
  value: number;
};

const escape = (value: string | number) => {
  if (typeof value === "number") return String(value);
  // Free text may originate with a provider. It must not become a spreadsheet formula.
  const literal = /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
};

export function chartCsv(rows: readonly ChartRecord[]) {
  return "\uFEFF" + [
    "time,zone,currency,basis,source,gap_type,series,value",
    ...rows.map((row) => [
      new Date(row.time).toISOString(), row.zone, row.currency, row.basis,
      row.source, row.gapType ?? "", row.series, row.value,
    ].map(escape).join(",")),
  ].join("\r\n");
}

export function downloadChartFile(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

export function exportChartCsv(rows: ChartRecord[]) {
  const url = URL.createObjectURL(new Blob([chartCsv(rows)], { type: "text/csv;charset=utf-8" }));
  downloadChartFile(url, "chart.csv");
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function exportChartPng(chart: ECharts, label: string, reading: string, background: string, foreground: string) {
  const image = new Image();
  image.src = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: background });
  await image.decode();
  const canvas = document.createElement("canvas");
  const rows = reading.split("\n").slice(0, 3);
  const header = 56 + rows.length * 33;
  canvas.width = Math.max(image.width, 640);
  canvas.height = image.height + header;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG unavailable");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = foreground;
  ctx.font = "600 27px system-ui";
  ctx.fillText(label, 22, 38, canvas.width - 44);
  ctx.font = "24px system-ui";
  rows.forEach((row, index) => ctx.fillText(row, 22, 68 + index * 33, canvas.width - 44));
  ctx.drawImage(image, 0, header, canvas.width, image.height);
  downloadChartFile(canvas.toDataURL("image/png"), "chart.png");
}
