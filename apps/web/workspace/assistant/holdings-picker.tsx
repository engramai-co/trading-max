"use client";

import { AtSign } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { useCopy } from "../foundation";

export function HoldingsPicker({disabled, onSelect}: {disabled: boolean; onSelect: (ticker: string) => void}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const holdings = useDashboardLens("holdings-positions", undefined, open && !disabled);
  const rows = [...new Map(holdings.data?.holdings?.map(item => [item.ticker, item]) ?? []).values()];
  return <Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" size="table" tabIndex={0} className="mx-assistant-holdings" disabled={disabled} />}>
      <AtSign size={16} aria-hidden="true" />{t("持仓", "Holdings")}
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="mx-assistant-holdings-popover" finalFocus={false}>
      <PopoverTitle className="sr-only">{t("持仓", "Holdings")}</PopoverTitle>
      {holdings.isPending ? <p role="status">{t("正在加载持仓…", "Loading holdings…")}</p> :
        holdings.isError ? <Button variant="secondary" onClick={() => void holdings.refetch()}>{t("重试加载持仓", "Retry loading holdings")}</Button> :
        rows.length ? rows.map(row => <Button key={row.ticker} variant="ghost" onClick={() => { setOpen(false); onSelect(row.ticker); }}>
          <strong>{row.ticker}</strong><span>{row.name}</span>
        </Button>) : <p>{t("暂无持仓。", "No holdings.")}</p>}
    </PopoverContent>
  </Popover>;
}
