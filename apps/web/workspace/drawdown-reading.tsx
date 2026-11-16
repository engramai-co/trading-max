"use client";

import type { DrawdownEpisode } from "@/lib/portfolio/drawdown-episodes";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { percent } from "@/workspace/data";
import { useCopy } from "./foundation";

export function drawdownMarks(episode: DrawdownEpisode | undefined, dates: string[], t: ReturnType<typeof useCopy>) {
  if (!episode) return [];
  return [
    { date: dates[episode.peak], name: t("高点", "Peak") },
    { date: dates[episode.trough], name: t("低点", "Trough") },
    ...(episode.recovery == null ? [] : [{ date: dates[episode.recovery], name: t("恢复", "Recovery") }]),
  ];
}

export function DrawdownReading({ episode, dates, basis }: {
  episode?: DrawdownEpisode;
  dates: string[];
  basis: "selected" | "all";
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  // Daily series (date-only or midnight UTC stamps) read as calendar days, never "00:00".
  const daily = dates.every((value) => !value.includes("T") || /T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00)$/.test(value));
  const displayDate = (value: string) => daily
    ? formatCalendarDate(value.slice(0, 10), locale) : formatDateTime(value, locale, timeZone);
  const marks = drawdownMarks(episode, dates, t);
  const days = episode?.recovery != null
    ? Math.ceil((Date.parse(dates[episode.recovery]) - Date.parse(dates[episode.peak])) / 86_400_000) : null;
  return <div className="mx-drawdown-reading">
    <span>{basis === "all" ? t("高点按全部可用历史确定", "Peak uses all available history") : t("高点按所选区间确定", "Peak uses the selected range")}</span>
    {episode && <dl>
      {marks.map((mark) => <div key={mark.name}><dt>{mark.name}</dt><dd><time dateTime={mark.date}>{displayDate(mark.date)}</time></dd></div>)}
      <div><dt>{t("回撤", "Drawdown")}</dt><dd className="mx-down">{percent(episode.depth, false, 2)}</dd></div>
      {days != null ? <div><dt>{t("持续时间", "Duration")}</dt><dd>{days} {t("天", "days")}</dd></div>
        : <div><dt>{t("状态", "Status")}</dt><dd>{episode.state === "interrupted"
          ? t("记录缺失，无法确认恢复", "Recovery unverified across a gap")
          : t("尚未恢复", "Not yet recovered")}</dd></div>}
    </dl>}
  </div>;
}
