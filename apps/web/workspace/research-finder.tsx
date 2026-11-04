"use client";

import type { SecuritySearchResponse, SecuritySearchResult } from "@/lib/types";
import { Button, Group, Modal, TextInput } from "@mantine/core";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, jsonRequest } from "@/workspace/data";
import { Empty, Instrument, Notice, Pending, useCopy } from "./foundation";

export function SecurityFinder({
  opened,
  onClose,
  initial,
  onAdded,
}: {
  opened: boolean;
  onClose: () => void;
  initial: string;
  onAdded: (ticker: string) => Promise<void>;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const [search, setSearch] = useState(() => (initial.trim().length >= 2 ? initial.trim() : ""));
  const currentText = (text || initial).trim();
  const showingCurrentSearch = search === currentText;
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
  const add = useMutation({
    mutationFn: (security: SecuritySearchResult) =>
      api("/watchlist", jsonRequest("POST", { security, refresh: true })),
    onSuccess: async (_, security) => onAdded(security.ticker),
  });
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (currentText.length < 2) return;
    if (showingCurrentSearch) void query.refetch();
    else setSearch(currentText);
  }
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("添加证券", "Add security")}
      size={620}
    >
      <form onSubmit={submit}>
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <TextInput
            flex={1}
            data-autofocus
            aria-label={t("搜索证券", "Search securities")}
            placeholder={
              initial || t("证券代码或公司名", "Ticker or company name")
            }
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.currentTarget.value)}
            leftSection={<MagnifyingGlass size={18} />}
          />
          <Button
            type="submit"
            disabled={currentText.length < 2}
            loading={query.isFetching && showingCurrentSearch}
          >
            {t("搜索", "Search")}
          </Button>
        </Group>
      </form>
      {add.isError && <Notice tone="bad">{add.error.message}</Notice>}
      {!showingCurrentSearch ? null : query.isError ? (
        <Notice tone="bad">
          {t(
            "搜索暂时不可用，请稍后重试。",
            "Search is temporarily unavailable. Please retry.",
          )}
        </Notice>
      ) : search.length >= 2 && query.isPending ? (
        <Pending compact />
      ) : query.data ? (
        query.data.results.length ? (
          <div style={{ marginTop: 20 }}>
            {query.data.results.slice(0, 3).map((r, i) => (
              <div className="mx-row-link" key={r.figi || r.ticker + i}>
                <Instrument ticker={r.ticker} name={r.name} small />
                <span className="mx-form-help">{r.exchange}</span>
                <Button
                  size="xs"
                  variant={r.alreadyWatched ? "default" : "light"}
                  loading={add.isPending && add.variables?.ticker === r.ticker}
                  disabled={add.isPending}
                  onClick={() =>
                    r.alreadyWatched ? void onAdded(r.ticker) : add.mutate(r)
                  }
                >
                  {r.alreadyWatched ? t("查看", "Open") : t("添加", "Add")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title={t("没有找到匹配证券", "No matching securities")}
            description={t(
              "尝试使用交易所代码或公司全名。",
              "Try an exchange ticker or the full company name.",
            )}
          />
        )
      ) : (
        <Empty
          title={t("搜索证券", "Search for a security")}
          description={t(
            "输入至少两个字符，搜索可研究的证券。",
            "Enter at least two characters to search available securities.",
          )}
        />
      )}
    </Modal>
  );
}
