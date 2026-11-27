"use client";

import { useCallback } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { Help, Tag } from "./foundation";
import type { EvidenceTime } from "./etf-data";

/** Evidence dates read as calendar days and instants in the reader's time zone, never as raw ISO strings. */
export function useEvidenceTime(): EvidenceTime {
  const { locale, timeZone } = useLocale();
  return useCallback((value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? formatCalendarDate(value, locale) : formatDateTime(value, locale, timeZone), [locale, timeZone]);
}

export function EvidenceReading({ display, description, status, basisLabel }: {
  display: string; description: string; status?: string; basisLabel?: string;
}) {
  const reading = <><span>{display}</span>{status && <Tag tone="warn">{status}</Tag>}</>;
  if (basisLabel) return <span className="mx-etf-reading">
    <Help label={basisLabel} triggerContent={reading} triggerLabel={basisLabel + " · " + display}>
      <p>{description}</p>
    </Help>
  </span>;
  return <span className="mx-etf-reading" role="group" aria-label={description} title={description}>
    <span aria-hidden="true">{display}</span>{status && <Tag tone="warn">{status}</Tag>}
  </span>;
}
