"use client";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Table2 } from "lucide-react";
import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";

const OpenedRecords = createContext(false);

/** Let the trigger share the chart's existing controls while the data opens below the plot. */
export function ChartRecords({ children, render }: { children: ReactNode; render?: ReactElement }) {
  const [opened, setOpened] = useState(false);
  return <Collapsible render={render} className={render ? undefined : "contents"} onOpenChange={(open) => { if (open) setOpened(true); }}>
    <OpenedRecords.Provider value={opened}>{children}</OpenedRecords.Provider>
  </Collapsible>;
}

export function ChartRecordsTrigger({ label, placement = "row" }: {
  label: string;
  placement?: "row" | "heading" | "actions";
}) {
  if (placement === "row") {
    return <CollapsibleTrigger render={<Button variant="ghost" className="group/disclosure max-w-full justify-start whitespace-normal text-start" />}>
      <ChevronDown size={16} aria-hidden="true" className="-rotate-90 group-data-[panel-open]/disclosure:rotate-0" />
      {label}
    </CollapsibleTrigger>;
  }
  // Short chart headings share part of the plot's top edge with the touch target.
  return <CollapsibleTrigger
    aria-label={label}
    data-chart-records-heading={placement === "heading" || undefined}
    render={<Button variant="ghost" size="icon" className={placement === "heading"
      ? "absolute end-0 top-0 z-1 text-muted-foreground aria-expanded:bg-accent [.mx-panel-heading>&]:-top-2 max-md:[.mx-decision-review_&]:-end-2"
      : "text-muted-foreground aria-expanded:bg-accent"} />}
  >
    <Table2 size={16} aria-hidden="true" />
  </CollapsibleTrigger>;
}

/** Mount data on first use and retain pagination if the reader collapses it. */
export function ChartRecordsPanel({ children, bordered = true }: { children: ReactNode; bordered?: boolean }) {
  const opened = useContext(OpenedRecords);
  return <CollapsibleContent keepMounted data-chart-records-panel className={bordered ? "mx-chart-data min-w-0" : "min-w-0"}>
    {opened && children}
  </CollapsibleContent>;
}
