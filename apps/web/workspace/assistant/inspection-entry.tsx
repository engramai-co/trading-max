"use client";

import dynamic from "next/dynamic";
import { useOptionalAssistant } from "./context";
import type { InspectionProps } from "./inspection";

const Reading = dynamic(() =>
  import("./inspection").then((module) => module.Inspection),
);

export function PageInspection(props: InspectionProps) {
  const ready = useOptionalAssistant()?.ready ?? false;
  return ready ? <Reading {...props} /> : null;
}
