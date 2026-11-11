"use client";

import { createContext, useContext } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { useCopy } from "./foundation";

export const Demonstration = createContext(false);

export function useDemonstration() {
  return useContext(Demonstration);
}

/** Synthetic fixtures are fixed at their as-of date and never await a refresh. */
export function DemoAsOf({ date }: { date?: string | null }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (!date) return null;

  return <time dateTime={date} className="mx-freshness">
    {t("数据截至", "Data as of")}{" "}
    {formatDate(date, locale, { year: "numeric", month: "short", day: "numeric", timeZone: date.length === 10 ? "UTC" : timeZone })}
  </time>;
}
