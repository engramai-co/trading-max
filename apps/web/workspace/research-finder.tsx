"use client";

import type { SecuritySearchResponse, SecuritySearchResult } from "@/lib/types";
import { Button, CloseButton, Modal, TextInput } from "@mantine/core";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/workspace/data";
import { Instrument, Notice, Pending, useCopy } from "./foundation";
import Link from "./link";
import { researchIndexHref, matchIndices, useIndexCatalog } from "./market-indices-data";

/**
 * One search for stocks, ETFs and indices. Indices come from the local catalogue
 * as the text changes; listings are looked up when the search is submitted,
 * because each lookup calls rate-limited listing providers.
 */
export function SecurityFinder({
  opened,
  onClose,
  initial,
  onSelect,
}: {
  opened: boolean;
  onClose: () => void;
  initial: string;
  onSelect: (security: SecuritySearchResult) => void;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const [search, setSearch] = useState(() => (initial.trim().length >= 2 ? initial.trim() : ""));
  const currentText = (text || initial).trim();
  const showingCurrentSearch = search === currentText;
  const indices = matchIndices(useIndexCatalog(opened && currentText.length >= 2).data, currentText).slice(0, 5);
  const query = useQuery({
    queryKey: ["workspace-security-search", opened ? search : "", 3],
    enabled: opened && search.length >= 2,
    queryFn: ({ signal }) =>
      api<SecuritySearchResponse>(
        "/securities/search?q=" + encodeURIComponent(search), { signal },
      ),
    staleTime: 60_000,
    retry: 0,
  });
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (currentText.length < 2) return;
    if (showingCurrentSearch) void query.refetch();
    else setSearch(currentText);
  }
  const results = showingCurrentSearch ? query.data?.results.slice(0, 3) ?? [] : [];
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("搜索", "Search")}
      withCloseButton={false}
      classNames={{ header: "sr-only", body: "mx-search-body" }}
      size={620}
    >
      <div className="mx-search-row">
        <form onSubmit={submit} role="search">
          <TextInput
            data-autofocus
            aria-label={t("搜索", "Search")}
            placeholder={initial || t("代码或名称", "Ticker or name")}
            enterKeyHint="search"
            autoComplete="off"
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.currentTarget.value)}
            leftSection={<MagnifyingGlass size={18} />}
          />
        </form>
        <CloseButton className="mx-search-close" size="lg" aria-label={t("关闭", "Close")} onClick={onClose} />
      </div>
      {indices.length > 0 && <div className="mx-index-search">
        {indices.map((index) => (
          <Link key={index.id} className="mx-row-link mx-research-index-result" href={researchIndexHref(index)} onClick={onClose}>
            <Instrument ticker={t(index.nameZh, index.name)} name={index.symbol ?? index.compiler} small />
            <span className="mx-form-help">{t("指数", "Index")}</span>
            <span>{t("查看", "Open")}</span>
          </Link>
        ))}
      </div>}
      {!showingCurrentSearch ? null : query.isError ? (
        <Notice tone="bad">
          {t(
            "搜索暂时不可用，请稍后重试。",
            "Search is temporarily unavailable. Please retry.",
          )}
        </Notice>
      ) : search.length >= 2 && query.isPending ? (
        <Pending compact />
      ) : results.length ? (
        <div className="mx-finder-results">
          {results.map((r, i) => (
            <div className="mx-row-link" key={r.figi || r.ticker + i}>
              <Instrument ticker={r.ticker} name={r.name} small />
              <span className="mx-form-help">{r.exchange}</span>
              <Button
                size="xs"
                variant={r.alreadyWatched ? "default" : "light"}
                onClick={() => onSelect(r)}
              >
                {t("查看", "Open")}
              </Button>
            </div>
          ))}
        </div>
      ) : query.data && !indices.length ? (
        <p className="mx-finder-empty" role="status">
          {t("没有找到“", "No results for “") + search + "”"}
        </p>
      ) : null}
    </Modal>
  );
}
