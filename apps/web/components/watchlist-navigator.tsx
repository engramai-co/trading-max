"use client";

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Combobox,
  Divider,
  Drawer,
  Group,
  InputBase,
  Loader,
  LoadingOverlay,
  Menu,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
  useCombobox,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  ArrowLeft,
  DotsThreeVertical,
  MagnifyingGlass,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { CompanyMark } from "@/components/company-mark";
import { useLocale } from "@/components/locale-provider";
import type {
  ResearchInstrument,
  SecuritySearchResponse,
  SecuritySearchResult,
  WatchlistCategory,
} from "@/lib/types";
import {
  visibleWatchlistCategories,
  watchlistAddPayload,
} from "@/lib/watchlist";

type NavigatorMode = "library" | "add";

type Props = {
  categories: WatchlistCategory[];
  instruments: ResearchInstrument[];
  selectedTicker: string;
  onSelectTicker: (ticker: string) => void;
  onTickerAdded?: (security: SecuritySearchResult) => void;
  onTickerRemoved?: (ticker: string) => void;
  pendingTicker?: string | null;
  headless?: boolean;
  mock?: boolean;
  openSignal?: number;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const TICKER_QUERY = /^[A-Z][A-Z0-9.-]{1,9}$/;
const MOCK_EXTERNAL_SECURITIES: SecuritySearchResult[] = [
  {
    alreadyWatched: false,
    bloombergTicker: "UBER US Equity",
    exchange: "NASDAQ",
    figi: "BBG-MOCK-UBER",
    name: "Uber Technologies Inc",
    securityType: "Common Stock",
    ticker: "UBER",
  },
  {
    alreadyWatched: false,
    bloombergTicker: "SPXC US Equity",
    exchange: "NYSE",
    figi: "BBG-MOCK-SPXC",
    name: "SPX Technologies Inc",
    securityType: "Common Stock",
    ticker: "SPXC",
  },
  {
    alreadyWatched: false,
    bloombergTicker: "SPSC US Equity",
    exchange: "NASDAQ",
    figi: "BBG-MOCK-SPSC",
    name: "SPS Commerce Inc",
    securityType: "Common Stock",
    ticker: "SPSC",
  },
];

function toSearchResult(instrument: ResearchInstrument): SecuritySearchResult {
  return {
    alreadyWatched: true,
    bloombergTicker: instrument.bloombergTicker,
    exchange: instrument.exchange,
    figi: instrument.figi,
    name: instrument.name,
    securityType: null,
    ticker: instrument.ticker,
  };
}

export function WatchlistNavigator({
  categories,
  headless = false,
  instruments,
  mock = false,
  openSignal = 0,
  selectedTicker,
  onSelectTicker,
  onTickerAdded,
  onTickerRemoved,
  pendingTicker,
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const router = useRouter();
  const params = useSearchParams();
  const displayCategories = useMemo(
    () => visibleWatchlistCategories(categories),
    [categories],
  );
  const requestedCategory = params.get("category") ?? "all";
  const [category, setCategory] = useState(
    displayCategories.some((item) => item.id === requestedCategory)
      ? requestedCategory
      : "all",
  );
  const [mode, setMode] = useState<NavigatorMode>("library");
  const [libraryQuery, setLibraryQuery] = useState("");
  const deferredLibraryQuery = useDeferredValue(libraryQuery);
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [addQuery, setAddQuery] = useState("");
  const [results, setResults] = useState<SecuritySearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [addingTicker, setAddingTicker] = useState<string | null>(null);
  const [removingTicker, setRemovingTicker] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const combobox = useCombobox();
  const previousOpenSignal = useRef(openSignal);
  const letterRefs = useRef(new Map<string, HTMLElement>());
  const activeCategory = category === "all"
    || displayCategories.some((item) => item.id === category)
    ? category
    : "all";

  const categoryCounts = useMemo(() => new Map([
    ["all", instruments.length],
    ...displayCategories.map((item) => [
      item.id,
      instruments.filter((instrument) => instrument.categoryId === item.id).length,
    ] as const),
  ]), [displayCategories, instruments]);

  const scopedInstruments = useMemo(() => instruments
    .filter((item) => activeCategory === "all" || item.categoryId === activeCategory),
  [activeCategory, instruments]);

  const visible = useMemo(() => {
    const normalized = deferredLibraryQuery.trim().toLocaleLowerCase();
    return scopedInstruments
      .filter((item) => !normalized || [
        item.ticker,
        item.name,
        item.exchange,
        locale === "zh" ? item.taxonomyLabelZh : item.taxonomyLabelEn,
      ].some((value) => value?.toLocaleLowerCase().includes(normalized)))
      .sort((left, right) => left.ticker.localeCompare(right.ticker));
  }, [deferredLibraryQuery, locale, scopedInstruments]);

  const groupedVisible = useMemo(() => {
    const groups = new Map<string, ResearchInstrument[]>();
    for (const instrument of visible) {
      const letter = /^[A-Z]$/.test(instrument.ticker[0] ?? "")
        ? instrument.ticker[0]
        : "#";
      groups.set(letter, [...(groups.get(letter) ?? []), instrument]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [visible]);

  const availableLetters = useMemo(
    () => new Set(groupedVisible.map(([letter]) => letter)),
    [groupedVisible],
  );
  const activeCategoryLabel = activeCategory === "all"
    ? (zh ? "全部标的" : "All securities")
    : locale === "zh"
      ? displayCategories.find((item) => item.id === activeCategory)?.labelZh
      : displayCategories.find((item) => item.id === activeCategory)?.labelEn;
  const categoryOptions = useMemo(() => [
    { label: `${zh ? "全部标的" : "All securities"} · ${instruments.length}`, value: "all" },
    ...displayCategories.map((item) => ({
      label: `${locale === "zh" ? item.labelZh : item.labelEn} · ${categoryCounts.get(item.id) ?? 0}`,
      value: item.id,
    })),
  ], [categoryCounts, displayCategories, instruments.length, locale, zh]);

  useEffect(() => {
    if (openSignal !== previousOpenSignal.current) {
      previousOpenSignal.current = openSignal;
      setMode("library");
      setOperationError(null);
      open();
    }
  }, [open, openSignal]);

  function showAddView(prefill = "") {
    setMode("add");
    setAddQuery(prefill);
    setResults([]);
    setHasSearched(false);
    setOperationError(null);
    combobox.closeDropdown();
  }

  function showLibraryView() {
    setMode("library");
    setAddQuery("");
    setResults([]);
    setHasSearched(false);
    setOperationError(null);
    combobox.closeDropdown();
  }

  function jumpToLetter(letter: string) {
    const target = letterRefs.current.get(letter);
    if (!target) return;
    setActiveLetter(letter);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function search(rawQuery = addQuery) {
    const normalized = rawQuery.trim();
    if (!normalized) return;
    setSearching(true);
    setHasSearched(true);
    setOperationError(null);
    try {
      if (mock) {
        await new Promise((resolve) => window.setTimeout(resolve, 320));
        const localCandidates = instruments.map(toSearchResult);
        const query = normalized.toLocaleLowerCase();
        const exactTicker = normalized.toUpperCase();
        const mockCandidates = exactTicker === "SPCX"
          ? MOCK_EXTERNAL_SECURITIES.filter((item) => (
            item.ticker === "SPXC" || item.ticker === "SPSC"
          ))
          : [...localCandidates, ...MOCK_EXTERNAL_SECURITIES];
        const matches = mockCandidates
          .filter((item) => (
            item.ticker.toLocaleLowerCase().includes(query)
            || item.name.toLocaleLowerCase().includes(query)
            || exactTicker === "SPCX"
          ))
          .sort((left, right) => (
            Number(right.ticker === exactTicker) - Number(left.ticker === exactTicker)
            || left.ticker.localeCompare(right.ticker)
          ));
        setResults(matches.slice(0, 8));
        combobox.openDropdown();
        return;
      }
      const response = await fetch(
        `/api/backend/securities/search?q=${encodeURIComponent(normalized)}`,
      );
      if (!response.ok) throw new Error(`search ${response.status}`);
      const payload = await response.json() as SecuritySearchResponse;
      setResults(payload.results);
      combobox.openDropdown();
    } catch {
      setResults([]);
      setOperationError(
        zh
          ? "暂时无法查找新标的，请重试。"
          : "New securities cannot be searched right now. Try again.",
      );
    } finally {
      setSearching(false);
    }
  }

  async function add(result: SecuritySearchResult) {
    if (result.alreadyWatched) {
      combobox.closeDropdown();
      close();
      onSelectTicker(result.ticker);
      return;
    }
    setAddingTicker(result.ticker);
    setOperationError(null);
    try {
      if (!mock) {
        const response = await fetch("/api/backend/watchlist", {
          body: JSON.stringify(watchlistAddPayload(result)),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error(`add ${response.status}`);
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 240));
      }
      combobox.closeDropdown();
      close();
      setAddQuery("");
      setResults([]);
      if (onTickerAdded) onTickerAdded(result);
      else onSelectTicker(result.ticker);
      if (!mock) router.refresh();
    } catch {
      setOperationError(
        zh
          ? `未能添加 ${result.ticker}，请重试。`
          : `${result.ticker} was not added. Try again.`,
      );
      combobox.openDropdown();
    } finally {
      setAddingTicker(null);
    }
  }

  async function remove(ticker: string) {
    if (mock || removingTicker) return;
    setRemovingTicker(ticker);
    setOperationError(null);
    try {
      const response = await fetch(
        `/api/backend/watchlist/${encodeURIComponent(ticker)}`,
        {
          body: JSON.stringify({ action: "remove" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) throw new Error(`remove ${response.status}`);
      onTickerRemoved?.(ticker);
      router.refresh();
    } catch {
      setOperationError(
        zh
          ? `未能删除 ${ticker}，请重试。`
          : `${ticker} was not removed. Try again.`,
      );
    } finally {
      setRemovingTicker(null);
    }
  }

  const libraryView = (
    <Stack gap="lg">
      <Box className="tm-security-search-actions">
        <Stack gap={6}>
          <Text fw={750} size="sm">
            {zh ? "搜索标的库" : "Search security library"}
          </Text>
          <InputBase
            aria-label={zh ? "搜索标的库" : "Search security library"}
            leftSection={<MagnifyingGlass size={18} />}
            onChange={(event) => {
              setLibraryQuery(event.currentTarget.value);
              setActiveLetter(null);
            }}
            placeholder={zh ? "输入 Ticker 或公司名称" : "Enter a ticker or company name"}
            rightSection={libraryQuery ? (
              <ActionIcon
                aria-label={zh ? "清除搜索" : "Clear search"}
                color="gray"
                onClick={() => {
                  setLibraryQuery("");
                  setActiveLetter(null);
                }}
                variant="subtle"
              >
                <X size={17} />
              </ActionIcon>
            ) : null}
            value={libraryQuery}
          />
        </Stack>
        <Button
          leftSection={<Plus size={17} />}
          onClick={() => showAddView()}
          size="sm"
          variant="default"
        >
          {zh ? "新增标的" : "Add security"}
        </Button>
      </Box>

      <Select
        aria-label={zh ? "选择分类" : "Choose category"}
        className="tm-security-category-mobile"
        data={categoryOptions}
        label={zh ? "分类" : "Category"}
        onChange={(value) => {
          setCategory(value ?? "all");
          setActiveLetter(null);
        }}
        value={activeCategory}
      />

      <Box className="tm-security-library-layout">
        <Paper className="tm-security-category-rail" p="sm" withBorder>
          <Text c="dimmed" fw={800} mb="xs" px="sm" size="xs">
            {zh ? "分类" : "CATEGORY"}
          </Text>
          <Stack gap={3}>
            {categoryOptions.map((item) => (
              <UnstyledButton
                className="tm-security-category-button"
                data-active={activeCategory === item.value || undefined}
                key={item.value}
                onClick={() => {
                  setCategory(item.value);
                  setActiveLetter(null);
                }}
              >
                <Text fw={activeCategory === item.value ? 750 : 600} lineClamp={1} size="sm">
                  {item.label.replace(/ · \d+$/, "")}
                </Text>
                <Text c="dimmed" size="xs">{categoryCounts.get(item.value) ?? 0}</Text>
              </UnstyledButton>
            ))}
          </Stack>
        </Paper>

        <Box className="tm-security-results">
          <Group justify="space-between" mb="md">
            <Text fw={800} size="lg">{activeCategoryLabel}</Text>
            <Text c="dimmed" size="sm">
              {zh ? `${visible.length} 个` : visible.length}
            </Text>
          </Group>

          {operationError ? (
            <Text aria-live="assertive" c="red" mb="md" role="alert" size="sm">
              {operationError}
            </Text>
          ) : null}

          {groupedVisible.length ? groupedVisible.map(([letter, letterInstruments]) => (
            <Box
              className="tm-security-letter-group"
              key={letter}
              ref={(node) => {
                if (node) letterRefs.current.set(letter, node);
                else letterRefs.current.delete(letter);
              }}
            >
              <Group gap="xs" mb="xs">
                <Text fw={800} size="lg">{letter}</Text>
                <Divider flex={1} />
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                {letterInstruments.map((instrument) => (
                  <Paper
                    className="tm-security-library-item"
                    data-selected={instrument.ticker === selectedTicker || undefined}
                    key={instrument.ticker}
                    pos="relative"
                    withBorder
                  >
                    <LoadingOverlay
                      visible={
                        removingTicker === instrument.ticker
                        || (
                          pending
                          && instrument.ticker === (pendingTicker ?? selectedTicker)
                        )
                      }
                    />
                    <Group gap={0} justify="space-between" wrap="nowrap">
                      <UnstyledButton
                        aria-label={`${zh ? "打开" : "Open"} ${instrument.name}`}
                        className="tm-security-library-button"
                        flex={1}
                        onClick={() => startTransition(() => {
                          close();
                          onSelectTicker(instrument.ticker);
                        })}
                      >
                        <Group gap="sm" wrap="nowrap">
                          <CompanyMark
                            name={instrument.name}
                            ticker={instrument.ticker}
                            website={instrument.website}
                          />
                          <div className="tm-security-library-copy">
                            <Group gap={7} wrap="nowrap">
                              <Text fw={800}>{instrument.ticker}</Text>
                              {instrument.held ? (
                                <Badge color="green" size="xs" variant="light">
                                  {zh ? "持仓" : "Held"}
                                </Badge>
                              ) : null}
                            </Group>
                            <Text lineClamp={1} size="sm">{instrument.name}</Text>
                            <Text c="dimmed" lineClamp={1} size="xs">
                              {locale === "zh" ? instrument.taxonomyLabelZh : instrument.taxonomyLabelEn}
                              {instrument.exchange ? ` · ${instrument.exchange}` : ""}
                            </Text>
                          </div>
                        </Group>
                      </UnstyledButton>
                      {!instrument.held ? (
                        <Menu position="bottom-end" shadow="md" withinPortal>
                          <Menu.Target>
                            <ActionIcon
                              aria-label={zh ? `管理 ${instrument.ticker}` : `Manage ${instrument.ticker}`}
                              color="gray"
                              mr="xs"
                              variant="subtle"
                            >
                              <DotsThreeVertical size={18} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              color="red"
                              disabled={mock || removingTicker !== null}
                              leftSection={removingTicker === instrument.ticker
                                ? <Loader size={16} />
                                : <Trash size={16} />}
                              onClick={() => void remove(instrument.ticker)}
                            >
                              {zh ? "从标的库删除" : "Remove from library"}
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      ) : null}
                    </Group>
                  </Paper>
                ))}
              </SimpleGrid>
            </Box>
          )) : (
            <Paper p="xl" ta="center" withBorder>
              <Text fw={700}>{zh ? "没有找到匹配的标的" : "No saved securities match"}</Text>
              {libraryQuery.trim() ? (
                <Button
                  leftSection={<Plus size={18} />}
                  mt="md"
                  onClick={() => showAddView(libraryQuery.trim())}
                  variant="light"
                >
                  {zh ? `查找并添加“${libraryQuery.trim()}”` : `Find and add “${libraryQuery.trim()}”`}
                </Button>
              ) : null}
            </Paper>
          )}
        </Box>

        <Stack className="tm-security-alphabet" gap={0}>
          {ALPHABET.map((letter) => (
            <UnstyledButton
              aria-label={zh ? `跳到 ${letter}` : `Jump to ${letter}`}
              className="tm-security-alphabet-key"
              data-active={activeLetter === letter || undefined}
              disabled={!availableLetters.has(letter)}
              key={letter}
              onClick={() => jumpToLetter(letter)}
            >
              {letter}
            </UnstyledButton>
          ))}
        </Stack>
      </Box>
    </Stack>
  );

  const detectedTicker = TICKER_QUERY.test(addQuery.trim().toUpperCase());
  const addView = (
    <Stack gap="md">
      <Group justify="space-between">
        <Button
          leftSection={<ArrowLeft size={18} />}
          onClick={showLibraryView}
          variant="subtle"
        >
          {zh ? "返回标的库" : "Back to library"}
        </Button>
        {detectedTicker ? (
          <Badge color="blue" variant="light">
            {zh ? "Ticker 快速查找" : "Ticker lookup"}
          </Badge>
        ) : null}
      </Group>

      <Combobox
        onOptionSubmit={(ticker) => {
          if (addingTicker) return;
          const result = results.find((item) => item.ticker === ticker);
          if (result) void add(result);
        }}
        store={combobox}
      >
        <Group align="stretch" gap="sm" wrap="nowrap">
          <Combobox.Target>
            <InputBase
              aria-label={zh ? "查找要添加的标的" : "Find a security to add"}
              flex={1}
              leftSection={<MagnifyingGlass size={18} />}
              onChange={(event) => {
                setAddQuery(event.currentTarget.value);
                setHasSearched(false);
                setResults([]);
                setOperationError(null);
                combobox.closeDropdown();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search();
                }
              }}
              placeholder={zh ? "输入 Ticker 或公司名称" : "Enter a ticker or company name"}
              value={addQuery}
            />
          </Combobox.Target>
          <Button
            leftSection={searching
              ? <Loader color="white" size={16} />
              : <MagnifyingGlass size={18} />}
            onClick={() => void search()}
          >
            {zh ? "查找" : "Find"}
          </Button>
        </Group>
        <Combobox.Dropdown className="tm-security-add-results">
          <Combobox.Options>
            {results.length ? results.map((result) => (
              <Combobox.Option
                disabled={addingTicker !== null && addingTicker !== result.ticker}
                key={result.figi || result.ticker}
                value={result.ticker}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <CompanyMark name={result.name} ticker={result.ticker} />
                    <div>
                      <Group gap="xs">
                        <Text fw={800}>{result.ticker}</Text>
                        <Text>{result.name}</Text>
                      </Group>
                      <Text c="dimmed" size="xs">{result.exchange}</Text>
                    </div>
                  </Group>
                  {addingTicker === result.ticker ? (
                    <Loader
                      aria-label={zh ? `正在添加 ${result.ticker}` : `Adding ${result.ticker}`}
                      size={18}
                    />
                  ) : result.alreadyWatched ? (
                    <Badge color="gray">{zh ? "打开" : "Open"}</Badge>
                  ) : (
                    <Badge color="blue" leftSection={<Plus size={12} />}>
                      {zh ? "添加" : "Add"}
                    </Badge>
                  )}
                </Group>
              </Combobox.Option>
            )) : hasSearched && !searching ? (
              <Combobox.Empty>
                {zh ? "没有找到可确认的证券" : "No verified security found"}
              </Combobox.Empty>
            ) : null}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>

      {searching ? (
        <Group aria-live="polite" gap="xs" role="status">
          <Loader size={15} />
          <Text size="sm">
            {detectedTicker
              ? (zh
                ? `正在查找 ${addQuery.trim().toUpperCase()}…`
                : `Looking up ${addQuery.trim().toUpperCase()}…`)
              : (zh ? "正在查找公司…" : "Looking up company…")}
          </Text>
        </Group>
      ) : null}

      {operationError ? (
        <Text aria-live="assertive" c="red" role="alert" size="sm">
          {operationError}
        </Text>
      ) : null}
    </Stack>
  );

  const drawer = (
    <Drawer
      keepMounted={false}
      opened={opened}
      onClose={close}
      position="bottom"
      size="92%"
      title={mode === "library"
        ? (zh ? "标的库" : "Security library")
        : (zh ? "添加标的" : "Add security")}
    >
      {mode === "library" ? libraryView : addView}
    </Drawer>
  );

  if (headless) return drawer;

  return (
    <>
      <Group justify="space-between" mb="md">
        <div>
          <Text c="dimmed" fw={700} size="xs">
            {zh
              ? `研究分类 · ${instruments.length}`
              : `Research groups · ${instruments.length}`}
          </Text>
          <Text fw={700}>{zh ? "标的库" : "Security library"}</Text>
        </div>
        <Button loading={pending} onClick={open} variant="default">
          {zh ? "打开标的库" : "Open security library"}
        </Button>
      </Group>
      {pending ? (
        <Text aria-live="polite" c="blue" size="sm">
          {zh
            ? `正在打开 ${pendingTicker ?? "标的"}…`
            : `Opening ${pendingTicker ?? "ticker"}…`}
        </Text>
      ) : null}
      {drawer}
    </>
  );
}
