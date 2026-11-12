"use client";

import { Tag } from "./foundation";
export function EvidenceReading({ display, description, status }: { display: string; description: string; status?: string }) {
  return <span className="mx-etf-reading" role="group" aria-label={description} title={description}>
    <span aria-hidden="true">{display}</span>{status && <Tag tone="warn">{status}</Tag>}
  </span>;
}
