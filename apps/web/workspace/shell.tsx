"use client";

import {
  ActionIcon,
  Button,
  CloseButton,
  Group,
  Menu,
  Modal,
  TextInput,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { useMediaQuery, useOs } from "@mantine/hooks";
import {
  ArrowRight,
  ChartBar,
  ChartLine,
  ChartPieSlice,
  Check,
  CircleHalf,
  ClockCounterClockwise,
  DotsThree,
  GearSix,
  Globe,
  Layout,
  MagnifyingGlass,
  Moon,
  SquaresFour,
  StackSimple,
  Sun,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import Link from "./link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { ResearchShell } from "@/lib/types";
import { BrandMark } from "@/ui/brand-mark";
import { api } from "@/workspace/data";
import { useEvidenceHighlight } from "./assistant/highlight";
import { AssistantEntry, AssistantPanel } from "./assistant/shell";
import { useAssistant } from "./assistant/context";
import { useWorkspaceProfile } from "./profile";
import { Tag, useCopy } from "./foundation";

import { researchShellKey } from "@/lib/dashboard-query";
import { useBuildNavigation } from "@/ui/publication-provider";
import { desktopPage, presentationLink } from "./desktop-routing";
import { DesktopStatus } from "./desktop-surfaces";
import { documentTitle, useDocumentTitle } from "./document-title";
import { useIndexCatalog } from "./market-indices-data";
import { useListedIndices } from "./listed-indices";
import { NavigationGroup, NavigationHint, NavigationIcon } from "./navigation-group";
import {
  findsSecurity, highlightParts, needsSecurity, pageAliases, recentVisit, rememberVisit, searchWorkspace,
  type SearchIndex, type SearchResult,
} from "./command-search";

function SearchHighlight({ text, query }: { text: string; query: string }) {
  return highlightParts(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>);
}

function SearchRouteObserver({ onChange }: { onChange: (search: string) => void }) {
  const params = useSearchParams();
  const search = params.toString();
  useEffect(() => onChange(search), [onChange, search]);
  return null;
}

export function WorkspaceShell({ children, desktop = false, localWorkspace = false, demonstration = false }: { children: React.ReactNode; desktop?: boolean; localWorkspace?: boolean; demonstration?: boolean }) {
  const t = useCopy();
  const assistant = useAssistant();
  const assistantOverlay = useMediaQuery("(max-width: 1199px)") && assistant.open;
  const actualPathname = usePathname();
  const [routeSearch, setRouteSearch] = useState("");
  const params = new URLSearchParams(routeSearch);
  const pathname = desktop ? "/" + (desktopPage(actualPathname) ?? "") : actualPathname;
  useEvidenceHighlight(pathname, routeSearch);
  const profile = useWorkspaceProfile();
  const router = useRouter();
  const navigateBuild = useBuildNavigation();
  const { locale, setLocale } = useLocale();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const os = useOs();
  const appleKeyboard = os === "macos" || os === "ios";
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<{ scope: string | null; visit: string; items: SearchResult[] }>({ scope: null, visit: "", items: [] });
  const searchId = useId();
  const resultsRef = useRef<HTMLDivElement>(null);
  const searchOpener = useRef<HTMLElement | null>(null);
  const restoreSearchFocus = useRef(false);
  const navigation = [
    {
      href: "/",
      label: t("组合总览", "Overview"),
      // Six dock cells are about 47px wide on a 320px phone; every name, Research
      // and Holdings included, is checked to fit there.
      mobileLabel: t("总览", "Home"),
      icon: SquaresFour,
      group: 0,
    },
    {
      href: "/holdings",
      label: t("持仓与穿透", "Holdings"),
      mobileLabel: t("持仓", "Holdings"),
      icon: ChartPieSlice,
      group: 0,
    },
    {
      href: "/analytics",
      label: t("收益与风险", "Performance"),
      mobileLabel: t("收益", "Returns"),
      icon: ChartLine,
      group: 0,
    },
    {
      href: "/sectors",
      label: t("市场", "Markets"),
      mobileLabel: t("市场", "Markets"),
      icon: Layout,
      group: 1,
    },
    {
      href: "/research",
      label: t("研究", "Research"),
      mobileLabel: t("研究", "Research"),
      icon: ChartBar,
      group: 1,
    },
    {
      href: "/review",
      label: t("投资复盘", "Review"),
      mobileLabel: t("复盘", "Review"),
      icon: ClockCounterClockwise,
      group: 1,
    },
    {
      href: "/health",
      label: t("数据状态", "Data status"),
      mobileLabel: t("数据状态", "Data status"),
      icon: StackSimple,
      group: 2,
    },
    {
      href: "/settings",
      label: t("设置", "Settings"),
      mobileLabel: t("设置", "Settings"),
      icon: GearSix,
      group: 2,
    },
  ];
  const active = navigation.find((n) =>
    n.href === "/"
      ? pathname === "/"
      : pathname.startsWith(n.href) ||
        (n.href === "/review" && pathname === "/account-analysis"),
  );
  useEffect(() => {
    function handle(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!event.repeat) {
          if (!searchOpen) searchOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          restoreSearchFocus.current = searchOpen;
          setSearchOpen(!searchOpen);
        }
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [searchOpen]);
  // The App has one appearance: macOS. Its native settings already follow it.
  useEffect(() => {
    if (desktop && colorScheme !== "auto") setColorScheme("auto");
  }, [desktop, colorScheme, setColorScheme]);
  // The page title moves into the top bar (or the App's title band) once the
  // large heading scrolls away.
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      root.toggleAttribute("data-scrolled", window.scrollY > 56);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      root.removeAttribute("data-scrolled");
    };
  }, []);
  useEffect(() => {
    if (searchOpen || !restoreSearchFocus.current) return;
    // Touch does not necessarily focus the trigger. Restore its focus only
    // after the background is no longer inert, never after a search navigation.
    const frame = requestAnimationFrame(() => {
      restoreSearchFocus.current = false;
      const opener = searchOpener.current;
      const target = opener && opener !== document.body && opener.isConnected && opener.getClientRects().length
        ? opener
        : Array.from(document.querySelectorAll<HTMLElement>("[data-search-trigger]")).find((element) => element.getClientRects().length);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);
  function closeSearch() {
    restoreSearchFocus.current = true;
    setSearchOpen(false);
  }
  const directory = useQuery({
    queryKey: researchShellKey,
    queryFn: ({ signal }) => api<ResearchShell>("/research/shell", { signal }),
    enabled: searchOpen,
    staleTime: 60_000,
    retry: 0,
  });
  const onIndexPage = pathname === "/research" && params.get("type") === "index";
  const indexCatalog = useIndexCatalog(searchOpen || onIndexPage);
  const listedIndices = useListedIndices();
  const indexName = (id: string) => {
    const index = indexCatalog.data?.find((item) => item.id === id);
    return index ? (locale === "zh" ? index.nameZh : index.name) : undefined;
  };
  const indices: SearchIndex[] = (indexCatalog.data ?? []).map((index) => ({
    id: index.id,
    label: locale === "zh" ? index.nameZh : index.name,
    detail: index.symbol ?? index.compiler ?? undefined,
    aliases: [index.name, index.nameZh, index.symbol ?? "", ...index.aliases].join(" "),
    listed: listedIndices.has(index.id),
  }));
  const match = query.trim().toLowerCase();
  const pages = navigation.map((item) => ({ href: item.href, label: item.label, aliases: pageAliases[item.href] }));
  const profileId = profile.data?.profileId ?? null;
  const visit = recentVisit(pathname, new URLSearchParams(routeSearch), pages, locale, indexName);
  const visitHref = visit?.href;
  const visitLabel = visit?.label;
  const visitKey = JSON.stringify([visitHref, visitLabel]);
  // Adjust route-derived history before children render, not in an effect that
  // would add another render after every navigation. Nothing leaves this shell.
  if (history.scope !== profileId || history.visit !== visitKey) {
    const items = history.scope === profileId ? history.items : [];
    setHistory({ scope: profileId, visit: visitKey, items: visit ? rememberVisit(items, visit) : items });
  }
  const recent = history.scope === profileId ? history.items.map((item) => {
    const url = new URL(item.href, "https://workspace.invalid");
    return recentVisit(url.pathname, url.searchParams, pages, locale, indexName) ?? item;
  }) : [];
  const currentTicker = pathname === "/research" ? params.get("ticker") : null;
  // The open stock, fund or index names the tab before the page does.
  useDocumentTitle(documentTitle(
    pathname === "/research" ? (onIndexPage ? indexName(params.get("index") ?? "") : params.get("ticker")) : null,
    active?.label,
  ));
  const researchIcon = navigation.find((page) => page.href === "/research")?.icon ?? MagnifyingGlass;
  const findText = query.trim();
  // On Research the address keeps its view, filters and everything else, and gains only the text
  // to find: the page opens its finder over itself and drops the text again, so closing the finder
  // leaves the page as it was. Elsewhere, and from a cited reading, which has no finder, Research
  // opens with the finder.
  const onResearch = pathname === "/research" && !params.has("evidence");
  const findQuery = new URLSearchParams(onResearch ? routeSearch : "");
  findQuery.set("find", findText);
  const results: Array<Omit<SearchResult, "group"> & {
    group: SearchResult["group"] | "holdings" | "securities";
    Icon: typeof MagnifyingGlass;
    replace?: boolean;
  }> = [
    ...searchWorkspace({ query, pages, instruments: directory.data?.instruments ?? [], indices, recent, currentTicker, locale })
      .map((item) => ({ ...item, Icon: navigation.find((page) => page.href === item.href.split("?")[0])?.icon ?? MagnifyingGlass })),
    ...(match
      ? [
          {
            href: "/holdings?q=" + encodeURIComponent(query.trim()),
            label:
              t("在持仓中搜索", "Search holdings") + " “" + query.trim() + "”",
            detail: undefined,
            group: "holdings" as const,
            Icon: ChartPieSlice,
          },
        ]
      : []),
    // A security outside the research list: the research finder searches every listing for it.
    ...(findsSecurity(findText, directory.data?.instruments ?? [])
      ? [
          {
            href: "/research?" + findQuery,
            label: t("在全部证券中查找", "Find in all securities") + " “" + findText + "”",
            detail: undefined,
            group: "securities" as const,
            Icon: researchIcon,
            replace: onResearch,
          },
        ]
      : []),
  ];
  const selectedIndex = Math.min(index, Math.max(0, results.length - 1));
  const groups = {
    recent: t("最近访问", "Recent"), pages: t("页面", "Pages"), research: t("研究清单", "Research list"),
    indices: t("指数", "Indices"), holdings: t("持仓", "Holdings"), securities: t("全部证券", "All securities"),
  };
  useEffect(() => {
    if (searchOpen) resultsRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query, searchOpen, results.length]);
  function navigate(href: string, replace = false) {
    restoreSearchFocus.current = false;
    setSearchOpen(false);
    const route = presentationLink(actualPathname, href);
    if (route.separate) window.open(route.href, "_blank", "noopener");
    // Only the address of the current page changes: no navigation, scroll, remount or history entry.
    // A fresh state, as the route helpers write, lets the router read the new address.
    else if (replace) window.history.replaceState(null, "", route.href);
    else if (!navigateBuild?.(route.href)) router.push(route.href);
  }
  const brand = (
    <Link
      href="/"
      className="mx-brand"
      aria-label={t("Trading Max · 组合总览", "Trading Max · Overview")}
    >
      <BrandMark size={32} className="mx-brand-symbol" />
      <span>
        Trading<span className="mx-brand-max">Max</span>
      </span>
    </Link>
  );
  const appearances = [
    { value: "light", label: t("浅色", "Light"), Icon: Sun },
    { value: "dark", label: t("深色", "Dark"), Icon: Moon },
    { value: "auto", label: t("跟随系统", "System"), Icon: CircleHalf },
  ] as const;
  const appearanceItems = appearances.map((item) => (
    <Menu.Item
      key={item.value}
      onClick={() => setColorScheme(item.value)}
      leftSection={<item.Icon size={17} />}
      rightSection={colorScheme === item.value && <Check size={15} />}
    >
      {item.label}
    </Menu.Item>
  ));
  const nextLocale = locale === "zh"
    ? { value: "en" as const, label: "English", lang: "en", action: "Switch to English" }
    : { value: "zh" as const, label: "中文", lang: "zh-CN", action: "切换到中文" };
  // Both top-bar menus open inside the banner landmark and focus their first
  // item: Mantine's focus placeholder is not a valid child of role="menu".
  const theme = (
    <Menu position="bottom-end" shadow="md" width={190} withinPortal={false} withInitialFocusPlaceholder={false}>
      <Menu.Target>
        <ActionIcon
          className="mx-topbar-preference"
          variant="subtle"
          aria-label={t("选择外观", "Choose appearance")}
        >
          <CircleHalf size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{appearanceItems}</Menu.Dropdown>
    </Menu>
  );
  // Phones reach the six main pages from the dock. This one menu holds only
  // what the dock lacks: workspace management and, on the web, preferences.
  const more = (
    <Menu
      position="bottom-end"
      shadow="md"
      width={220}
      withinPortal={false}
      withInitialFocusPlaceholder={false}
      classNames={{ dropdown: "mx-more-menu" }}
    >
      <Menu.Target>
        <ActionIcon className="mx-topbar-more" variant="subtle" aria-label={t("更多", "More")}>
          <DotsThree size={22} weight="bold" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {navigation.filter((n) => n.group === 2).map((n) => (
          <Menu.Item
            key={n.href}
            component={Link}
            href={n.href}
            aria-current={active?.href === n.href ? "page" : undefined}
            leftSection={<n.icon size={17} weight={active?.href === n.href ? "fill" : "regular"} />}
          >
            {n.label}
          </Menu.Item>
        ))}
        {!desktop && (
          <>
            <Menu.Divider role="separator" />
            <Menu.Item
              leftSection={<Globe size={17} />}
              aria-label={nextLocale.action}
              onClick={() => setLocale(nextLocale.value)}
            >
              <span lang={nextLocale.lang}>{nextLocale.label}</span>
            </Menu.Item>
            <Menu.Divider role="separator" />
            {appearanceItems}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
  const links = (groups: number[], compact = false) => (
    <NavigationGroup activeHref={active && groups.includes(active.group) ? active.href : undefined}>
    {navigation
      .filter((n) => groups.includes(n.group))
      .map((n) => (
        <NavigationHint key={n.href} label={n.label} enabled={compact}>
        <Link
          href={n.href}
          aria-label={n.label}
          aria-current={active?.href === n.href ? "page" : undefined}
          className="mx-nav-link"
        >
          {compact ? <NavigationIcon icon={n.icon} /> : <><n.icon
            size={20}
            weight={active?.href === n.href ? "fill" : "regular"}
            aria-hidden="true"
          />
          <span>{n.label}</span></>}
        </Link>
        </NavigationHint>
      ))}
    </NavigationGroup>
  );
  const searchTrigger = (className: string, position: "bottom-end" | "right") => (
    <Tooltip
      label={<>{t("搜索", "Search")}{os !== "undetermined" && <kbd>{appleKeyboard ? "⌘ K" : "Ctrl K"}</kbd>}</>}
      position={position}
      offset={position === "right" ? 12 : 8}
      interactive
    >
      <ActionIcon
        className={className}
        variant="subtle"
        data-search-trigger
        aria-label={t("搜索", "Search")}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        aria-keyshortcuts={appleKeyboard ? "Meta+K" : "Control+K"}
        onClick={(event) => {
          searchOpener.current = event.currentTarget;
          restoreSearchFocus.current = false;
          setSearchOpen(true);
        }}
      >
        <MagnifyingGlass size={desktop && position === "right" ? 22 : 19} aria-hidden="true" />
      </ActionIcon>
    </Tooltip>
  );
  return (
    <div className={desktop ? "mx-app mx-desktop-app" : "mx-app"} inert={searchOpen} data-assistant-open={assistant.open || undefined}>
      <Suspense fallback={null}><SearchRouteObserver onChange={setRouteSearch} /></Suspense>
      <a className="mx-skip" href="#main-content" inert={assistantOverlay || undefined}>
        {t("跳到正文", "Skip to content")}
      </a>
      <aside className="mx-sidebar" inert={assistantOverlay || undefined}>
        <Tooltip.Group openDelay={250} closeDelay={100}>
        {brand}
        {desktop && searchTrigger("mx-sidebar-search", "right")}
        <nav aria-label={t("主导航", "Primary navigation")}>
          {links([0, 1], true)}
        </nav>
        <div className="mx-sidebar-bottom">
          {desktop ? <DesktopStatus localWorkspace={localWorkspace} demonstration={demonstration} /> : <nav aria-label={t("工作区管理", "Workspace management")}>
            {links([2], true)}
          </nav>}
        </div>
        </Tooltip.Group>
      </aside>
      <div className="mx-content" inert={assistantOverlay || undefined}>
        <header className="mx-topbar">
          <div className="mx-topbar-title">
            <span className="mx-topbar-workspace">
              {profile.data?.displayName ||
                t("工作区", "Workspace")}
            </span>
            <span className="mx-breadcrumb-divider">/</span>
            <strong>{active?.label}</strong>
          </div>
          <Group gap={4} wrap="nowrap">
            {demonstration && <Tag>{t("演示数据", "Demo data")}</Tag>}
            <AssistantEntry />
            {searchTrigger("mx-topbar-search", "bottom-end")}
            {/* In the App, language lives in workspace preferences and appearance follows macOS. */}
            {!desktop && <ActionIcon
              className="mx-topbar-preference"
              aria-label={nextLocale.action}
              onClick={() => setLocale(nextLocale.value)}
            >
              <Globe size={19} />
            </ActionIcon>}
            {!desktop && theme}
            {more}
          </Group>
        </header>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <AssistantPanel overlay={assistantOverlay} page={active?.href.slice(1) || "overview"} search={routeSearch} scopeLabel={active?.label ?? t("工作区", "Workspace")} searchOpen={searchOpen} />
      <nav inert={assistantOverlay || undefined}
        className="mx-mobile-dock"
        aria-label={t("快捷导航", "Quick navigation")}
      >
        <NavigationGroup activeHref={active && active.group < 2 ? active.href : undefined}>
        {navigation
          .filter((n) => n.group < 2)
          .map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="mx-mobile-dock-link"
              aria-current={active?.href === n.href ? "page" : undefined}
            >
              <NavigationIcon icon={n.icon} />
              <span>{n.mobileLabel}</span>
            </Link>
          ))}
        </NavigationGroup>
      </nav>
      <Modal
        opened={searchOpen}
        onClose={closeSearch}
        returnFocus={false}
        zIndex={1100}
        transitionProps={{ duration: 0 }}
        closeOnEscape={false}
        // Mantine drawers listen during window capture. Mark the focused target
        // before Escape reaches them; this dialog alone handles its close.
        onFocusCapture={(event) => event.target.setAttribute("data-mantine-stop-propagation", "true")}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            closeSearch();
          }
        }}
        onExitTransitionEnd={() => {
          setQuery("");
          setIndex(0);
        }}
        title={t("搜索", "Search")}
        withCloseButton={false}
        classNames={{ content: "mx-command-dialog", header: "sr-only", body: "mx-search-body" }}
        size={600}
      >
        <div className="mx-search-row">
          <TextInput
            data-autofocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls={searchId + "-results"}
            aria-activedescendant={results[selectedIndex] ? searchId + "-" + selectedIndex : undefined}
            aria-label={t("搜索", "Search")}
            placeholder={t("页面、代码或名称", "Page, ticker or name")}
            leftSection={<MagnifyingGlass size={20} />}
            value={query}
            maxLength={160}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((i) =>
                  Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      Math.min(i, Math.max(0, results.length - 1)) + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              }
              if (event.key === "Enter" && results[selectedIndex]) {
                event.preventDefault();
                navigate(results[selectedIndex].href, results[selectedIndex].replace);
              }
            }}
          />
          <CloseButton className="mx-search-close" size="lg" aria-label={t("关闭", "Close")} onClick={closeSearch} />
        </div>
        <div className="mx-command-results" ref={resultsRef} id={searchId + "-results"} role="listbox" aria-label={t("搜索结果", "Search results")}>
          {results.map((item, i) => (
            <Fragment key={item.href}>
              {item.group !== results[i - 1]?.group && (
                <div className="mx-command-group" role="presentation"><span>{groups[item.group]}</span></div>
              )}
              <button
                type="button"
                role="option"
                id={searchId + "-" + i}
                aria-selected={i === selectedIndex}
                tabIndex={-1}
                className="mx-command-result"
                data-active={i === selectedIndex || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => navigate(item.href, item.replace)}
                onFocus={() => setIndex(i)}
              >
                <item.Icon size={20} aria-hidden="true" />
                <span>
                  <strong><SearchHighlight text={item.label} query={query} /></strong>
                  {item.detail && <small><SearchHighlight text={item.detail} query={query} /></small>}
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </Fragment>
          ))}
        </div>
        {needsSecurity(query, currentTicker) && (
          <p className="mx-command-status" role="status">{t("加上代码，例如 ARM 技术面。", "Add a ticker, such as ARM technical.")}</p>
        )}
        {match && results.every((item) => item.group === "holdings") && !directory.isFetching && !needsSecurity(query, currentTicker) && (
          <p className="mx-command-status" role="status">{t("没有找到“", "No results for “") + query.trim() + "”"}</p>
        )}
        {directory.isPending && (
          <p className="mx-command-status" role="status">
            {t("正在加载研究清单…", "Loading research list…")}
          </p>
        )}
        {directory.isError && (
          <div className="mx-command-status" role="status">
            <span>
              {t(
                "研究清单暂不可用，页面搜索仍可使用。",
                "Research list unavailable. You can still search pages.",
              )}
            </span>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => void directory.refetch()}
            >
              {t("重试", "Retry")}
            </Button>
          </div>
        )}
        {!match && recent.length > 0 && <div className="mx-command-recent-actions"><button type="button" className="mx-command-clear" onClick={() => setHistory((previous) => ({ ...previous, items: [] }))}>{t("清除最近访问", "Clear recent")}</button></div>}
        <div className="mx-command-footer">
          <span>{t("↑ ↓ 选择 · Enter 打开", "↑ ↓ navigate · Enter open")}</span>
          <span>Esc {t("关闭", "close")}</span>
        </div>
      </Modal>
    </div>
  );
}
