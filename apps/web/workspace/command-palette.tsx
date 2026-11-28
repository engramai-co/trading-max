"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Button, CloseButton } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { searchInputHints } from "@/components/ui/search-input";
import { highlightParts, type SearchResult } from "./command-search";
import { StatusMessage, useCopy } from "./foundation";
import { WorkspaceDialog } from "./overlay";
import { isImeComposing } from "./shortcut-platform";

export type CommandResult = Omit<SearchResult, "group"> & {
  group: SearchResult["group"] | "holdings" | "securities";
  Icon: LucideIcon;
  replace?: boolean;
};

function SearchHighlight({ text, query }: { text: string; query: string }) {
  return highlightParts(text, query).map((part, index) => part.match
    ? <mark key={index}>{part.text}</mark>
    : <Fragment key={index}>{part.text}</Fragment>);
}

// cmdk auto-selects an item when its controlled value is empty.
const noSelection = "__no_selection__";

function fitMobileViewport(element: HTMLDivElement | null) {
  const dialog = element?.closest<HTMLElement>(".tm-command-dialog");
  const viewport = window.visualViewport;
  if (!dialog || !viewport) return;
  const update = () => {
    // iOS can shrink and pan the visual viewport for the keyboard while
    // leaving dvh unchanged. Leave pinch zoom under the browser's control.
    if (viewport.scale !== 1) {
      dialog.style.removeProperty("--command-viewport-height");
      dialog.style.removeProperty("--command-viewport-top");
      return;
    }
    dialog.style.setProperty("--command-viewport-height", `${viewport.height}px`);
    dialog.style.setProperty("--command-viewport-top", `${viewport.offsetTop}px`);
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}

export function CommandPalette({
  open, onClose, query, onQueryChange, results, onSelect, allowImplicitFallback, matchCount,
  searchHint, noResults, providerMessage, providerNotice, onRetry, onClearRecent,
}: {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: CommandResult[];
  onSelect: (item: CommandResult, keyboard: boolean) => void;
  allowImplicitFallback: boolean;
  matchCount?: number;
  searchHint?: string;
  noResults?: string;
  providerMessage?: string;
  providerNotice?: string;
  onRetry?: () => void;
  onClearRecent?: () => void;
}) {
  const t = useCopy();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const keyboard = useRef(false);
  const [selection, setSelection] = useState<string>();
  const selectedExists = results.some((item) => item.href === selection);
  if (selection && selection !== noSelection && !selectedExists) setSelection(noSelection);
  const first = results[0];
  const implicit = first && (allowImplicitFallback || (first.group !== "holdings" && first.group !== "securities")) ? first.href : noSelection;
  const selected = selection === undefined ? implicit : selectedExists ? selection : noSelection;
  const selectedId = selected === noSelection ? undefined : id + encodeURIComponent(selected);
  useEffect(() => {
    if (open && selectedId) document.getElementById(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [open, selectedId]);

  const searchLabel = t("搜索", "Search");
  const groups = {
    recent: t("最近访问", "Recent"),
    pages: t("页面", "Pages"),
    research: t("研究清单", "Research list"),
    indices: t("指数", "Indices"),
    holdings: t("持仓", "Holdings"),
    securities: t("全部证券", "All securities"),
  };
  const grouped = new Map<CommandResult["group"], CommandResult[]>();
  for (const item of results) {
    const group = grouped.get(item.group);
    if (group) group.push(item);
    else grouped.set(item.group, [item]);
  }
  const reading = searchHint ?? noResults ?? (matchCount === undefined || matchCount === 0 ? undefined
    : matchCount + (matchCount === 1 ? t(" 项结果", " result") : t(" 项结果", " results")));
  const announcement = [providerMessage, reading].filter(Boolean).join(" ");

  return (
    <WorkspaceDialog
      open={open}
      onClose={onClose}
      initialFocus={input}
      finalFocus={false}
      onClosed={() => {
        onQueryChange("");
        setSelection(undefined);
      }}
      title={searchLabel}
      hideClose
      className="tm-command-dialog"
      headerClassName="sr-only"
      bodyClassName="tm-command-body"
      width={600}
    >
      <StatusMessage message={announcement} />
      <Command
        ref={fitMobileViewport}
        className="tm-command"
        label={searchLabel}
        shouldFilter={false}
        value={selected}
        onValueChange={setSelection}
        disablePointerSelection
        vimBindings={false}
      >
        <div className="tm-command-search" role="search" aria-label={searchLabel}>
          <CommandInput
            {...searchInputHints}
            ref={input}
            name="q"
            value={query}
            aria-activedescendant={selectedId}
            maxLength={160}
            placeholder={t("页面、代码或名称", "Page, ticker or name")}
            onKeyDown={(event) => {
              // Leave the IME's default editing action intact. cmdk must not
              // see the confirming Enter before composition finishes.
              if (isImeComposing(event)) {
                event.stopPropagation();
                return;
              }
              // Keep text-editing keys and OS shortcuts ahead of cmdk.
              if (event.key === "Home" || event.key === "End" ||
                  ((event.key === "ArrowDown" || event.key === "ArrowUp") && (event.altKey || event.metaKey))) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Enter") {
                keyboard.current = true;
                queueMicrotask(() => { keyboard.current = false; });
              }
            }}
            onChange={(event) => {
              setSelection(undefined);
              onQueryChange(event.currentTarget.value);
            }}
          />
        </div>
        <CommandList className="tm-command-list" label={t("搜索结果", "Search results")}>
          {Array.from(grouped, ([group, items]) => (
            <CommandGroup key={group} heading={groups[group]}>
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={item.href}
                  asChild
                  onSelect={() => onSelect(item, keyboard.current)}
                >
                  <div id={id + encodeURIComponent(item.href)} onMouseDown={(event) => event.preventDefault()}>
                    <item.Icon size={20} aria-hidden="true" />
                    <span>
                      <strong><SearchHighlight text={item.label} query={query} /></strong>
                      {item.detail && <small><SearchHighlight text={item.detail} query={query} /></small>}
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      <CloseButton className="absolute tm-command-close" iconSize={18} aria-label={t("关闭", "Close")} onClick={onClose} />
      {reading && (searchHint || noResults) && <p className="tm-command-status" aria-hidden="true">{reading}</p>}
      {providerNotice && (
        <div className="tm-command-status">
          <span aria-hidden="true">{providerNotice}</span>
          {onRetry && <Button variant="ghost" onClick={() => {
            input.current?.focus({ preventScroll: true });
            onRetry();
          }}>{t("重试", "Retry")}</Button>}
        </div>
      )}
      {onClearRecent && <div className="tm-command-recent">
        <Button variant="link" className="text-xs" onClick={() => {
          input.current?.focus({ preventScroll: true });
          onClearRecent();
        }}>{t("清除最近访问", "Clear recent")}</Button>
      </div>}
      <div className="tm-command-footer">
        <span>{t("↑ ↓ 选择 · Enter 打开", "↑ ↓ navigate · Enter open")}</span>
        <span>Esc {t("关闭", "close")}</span>
      </div>
    </WorkspaceDialog>
  );
}
