"use client";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WorkspaceDialog } from "./overlay";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { searchInputHints } from "@/components/ui/search-input";
import { useColorScheme } from "@/components/color-scheme-provider";
import { Button, buttonVariants, CloseButton } from "@/components/ui/button";
import { isColorScheme } from "@/lib/color-scheme";
import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useBreakpoint, useOs } from "@/lib/hooks";
import {
  ArrowRight,
  ChartColumnIncreasing,
  ChartLine,
  ChartPie,
  Check,
  Contrast,
  Ellipsis,
  Globe,
  Grid2X2,
  History,
  Layers2,
  Moon,
  PanelsTopLeft,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "./link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useId, useRef, useState, type FocusEvent } from "react";
import { useLocale } from "@/components/locale-provider";
import type { ResearchShell } from "@/lib/types";
import { BrandMark } from "@/ui/brand-mark";
import { api } from "@/workspace/data";
import { useEvidenceHighlight } from "./assistant/highlight";
import { AssistantEntry, AssistantPanel } from "./assistant/shell";
import { useAssistant } from "./assistant/context";
import { useWorkspaceProfile } from "./profile";
import { Tip, Tag, StatusMessage, useCopy } from "./foundation";
import { isImeComposing } from "./shortcut-platform";

import { researchShellKey } from "@/lib/dashboard-query";
import { useBuildNavigation } from "@/ui/publication-provider";
import { desktopPage, presentationLink } from "./desktop-routing";
import { DesktopStatus } from "./desktop-surfaces";
import { documentTitle, useDocumentTitle } from "./document-title";
import { useBrowserOnline } from "@/ui/query-client";
import { useIndexCatalog } from "./market-indices-data";
import { useListedIndices } from "./listed-indices";
import { NavigationGroup, NavigationHint, NavigationIcon, railLink } from "./navigation-group";
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
  const compactAssistant = useBreakpoint("compactDesktop");
  const assistantOverlay = compactAssistant && assistant.open;
  // Search names each page as the visible navigation does: the dock's short names wherever the dock shows.
  const dock = useBreakpoint("phoneDock");
  const actualPathname = usePathname();
  const [routeSearch, setRouteSearch] = useState("");
  const params = new URLSearchParams(routeSearch);
  const pathname = desktop ? "/" + (desktopPage(actualPathname) ?? "") : actualPathname;
  useEvidenceHighlight(pathname, routeSearch);
  const profile = useWorkspaceProfile();
  const router = useRouter();
  const navigateBuild = useBuildNavigation();
  const { locale, setLocale } = useLocale();
  const { colorScheme, osColorScheme, setColorScheme } = useColorScheme();
  const os = useOs();
  const appleKeyboard = os === "macos" || os === "ios";
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<{ scope: string | null; visit: string; items: SearchResult[] }>({ scope: null, visit: "", items: [] });
  const searchId = useId();
  const topbarRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
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
      icon: Grid2X2,
      group: 0,
    },
    {
      href: "/holdings",
      label: t("持仓与穿透", "Holdings"),
      mobileLabel: t("持仓", "Holdings"),
      icon: ChartPie,
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
      icon: PanelsTopLeft,
      group: 1,
    },
    {
      href: "/research",
      label: t("研究", "Research"),
      mobileLabel: t("研究", "Research"),
      icon: ChartColumnIncreasing,
      group: 1,
    },
    {
      href: "/review",
      label: t("投资复盘", "Review"),
      mobileLabel: t("复盘", "Review"),
      icon: History,
      group: 1,
    },
    {
      href: "/health",
      label: t("数据状态", "Data status"),
      mobileLabel: t("数据状态", "Data status"),
      icon: Layers2,
      group: 2,
    },
    {
      href: "/settings",
      label: t("设置", "Settings"),
      mobileLabel: t("设置", "Settings"),
      icon: Settings,
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
      if (!isImeComposing(event) && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
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
  // The title moves into the bar once the large heading scrolls away.
  // Short landscape also tracks direction for Safari's sticky header.
  useEffect(() => {
    const root = document.documentElement;
    const topbar = topbarRef.current;
    const shortLandscape = window.matchMedia(MEDIA_QUERIES.shortLandscapeDock);
    let frame = 0;
    let previousY = window.scrollY;
    const update = () => {
      frame = 0;
      root.toggleAttribute("data-scrolled", window.scrollY > 56);
      if (!shortLandscape.matches || !topbar) return;
      // Ignore rubber-band overscroll when reading the scroll direction.
      const y = Math.max(0, Math.min(window.scrollY, root.scrollHeight - window.innerHeight));
      if (y !== previousY) topbar.toggleAttribute("data-scroll-down", y > previousY && y >= topbar.offsetHeight);
      previousY = y;
    };
    const reset = () => {
      previousY = window.scrollY;
      topbar?.removeAttribute("data-scroll-down");
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    shortLandscape.addEventListener("change", reset);
    return () => {
      window.removeEventListener("scroll", schedule);
      shortLandscape.removeEventListener("change", reset);
      cancelAnimationFrame(frame);
      reset();
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
  const online = useBrowserOnline();
  const directoryOffline = !online || directory.fetchStatus === "paused" || indexCatalog.fetchStatus === "paused";
  const researchFailed = directory.isError;
  const indexFailed = indexCatalog.isError;
  const catalogPending = directory.isPending || indexCatalog.isPending;
  const catalogsReady = directory.isSuccess && indexCatalog.isSuccess;
  const directoryIssue = directoryOffline
    ? t("网络已断开。页面搜索仍可使用，研究清单将在重连后更新。", "You’re offline. You can still search pages. The research list will update when you reconnect.")
    : researchFailed ? t("研究清单暂不可用，页面搜索仍可使用。", "Research list unavailable. You can still search pages.")
    : indexFailed ? t("指数查询暂不可用，页面搜索仍可使用。", "Index search unavailable. You can still search pages.") : undefined;
  const [previousDirectoryIssue, setPreviousDirectoryIssue] = useState<string>();
  if (searchOpen && previousDirectoryIssue !== directoryIssue && directoryIssue) setPreviousDirectoryIssue(directoryIssue);
  else if (!searchOpen && previousDirectoryIssue) setPreviousDirectoryIssue(undefined);
  const directoryLoading = t("正在加载研究清单…", "Loading research list…");
  const directoryMessage = directoryIssue ?? (catalogPending
    ? directoryLoading
    : previousDirectoryIssue && catalogsReady ? t("研究清单可用。", "Research list available.") : undefined);
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
  const pages = navigation.map((item) => ({ href: item.href, label: dock ? item.mobileLabel : item.label, aliases: pageAliases[item.href] }));
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
  const researchIcon = navigation.find((page) => page.href === "/research")?.icon ?? Search;
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
    Icon: LucideIcon;
    replace?: boolean;
  }> = [
    ...searchWorkspace({ query, pages, instruments: directory.data?.instruments ?? [], indices, recent, currentTicker, locale })
      .map((item) => ({ ...item, Icon: navigation.find((page) => page.href === item.href.split("?")[0])?.icon ?? Search })),
    ...(match
      ? [
          {
            href: "/holdings?q=" + encodeURIComponent(query.trim()),
            label:
              t("在持仓中搜索", "Search holdings") + " “" + query.trim() + "”",
            detail: undefined,
            group: "holdings" as const,
            Icon: ChartPie,
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
  function revealPageFocus(event: FocusEvent<HTMLElement>) {
    const target = event.target;
    if (!event.currentTarget.contains(target) || target.tabIndex < 0 || !target.matches(":focus-visible")) return;
    cancelAnimationFrame(focusFrame.current);
    // Scroll padding guides native focus navigation. Correct engines that leave
    // a target behind a bar when it was already technically in the viewport.
    focusFrame.current = requestAnimationFrame(() => {
      if (document.activeElement !== target || !target.getClientRects().length) return;
      const topbar = topbarRef.current;
      const headerBottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
      const dockBottom = dockRef.current?.getBoundingClientRect();
      const end = dockBottom?.height ? dockBottom.top : window.innerHeight;
      const box = target.getBoundingClientRect();
      let start = headerBottom;
      const strip = target.closest(".mx-reading-sections")?.parentElement?.querySelector(".mx-section-rail");
      const stripBox = strip?.getBoundingClientRect();
      if (strip && stripBox && getComputedStyle(strip).display === "block" && stripBox.top <= start + 1) {
        start = Math.max(start, stripBox.bottom);
      }
      const gap = 4; // The outline plus its offset.
      if (box.top < start + gap) window.scrollBy({ top: box.top - start - gap, behavior: "instant" });
      else if (box.bottom > end - gap && box.height <= end - start - gap * 2) {
        window.scrollBy({ top: box.bottom - end + gap, behavior: "instant" });
      }
    });
  }

  const systemResolved = osColorScheme === "dark"
    ? t("深色", "Dark")
    : osColorScheme === "light"
      ? t("浅色", "Light")
      : null;
  const appearances = [
    { value: "light", label: t("浅色", "Light"), Icon: Sun },
    { value: "dark", label: t("深色", "Dark"), Icon: Moon },
    {
      value: "auto",
      label: systemResolved ? `${t("跟随系统", "System")} · ${systemResolved}` : t("跟随系统", "System"),
      Icon: Contrast,
    },
  ] as const;
  const appearanceItems = (
    <DropdownMenuRadioGroup
      aria-label={t("外观", "Appearance")}
      value={colorScheme}
      onValueChange={(value) => { if (isColorScheme(value)) setColorScheme(value); }}
    >
      {appearances.map((item) => (
        <DropdownMenuRadioItem key={item.value} value={item.value} closeOnClick>
          <item.Icon size={18} className="size-[18px]" aria-hidden="true" />
          {item.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const nextLocale = locale === "zh"
    ? { value: "en" as const, label: "English", lang: "en", action: "Switch to English" }
    : { value: "zh" as const, label: "中文", lang: "zh-CN", action: "切换到中文" };
  const theme = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: "ghost", size: "icon", className: "mx-topbar-preference" })}
        aria-label={t("选择外观", "Choose appearance")}
      >
        <Contrast size={20} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="mx-appearance-menu">{appearanceItems}</DropdownMenuContent>
    </DropdownMenu>
  );
  // Phones reach the six main pages from the dock. This one menu holds only
  // what the dock lacks: workspace management and, on the web, preferences.
  const more = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: "ghost", size: "icon", className: "mx-topbar-more" })}
        aria-label={t("更多", "More")}
      >
        <Ellipsis size={20} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="mx-more-menu">
        {navigation.filter((n) => n.group === 2).map((n) => (
          <DropdownMenuItem
            key={n.href}
            nativeButton={false}
            render={<Link href={n.href} />}
            aria-current={active?.href === n.href ? "page" : undefined}
            className="no-underline aria-[current=page]:font-semibold"
          >
            <n.icon size={18} className="size-[18px]" aria-hidden="true" />
            {n.label}
            {active?.href === n.href && <Check className="ml-auto" size={16} aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        {!desktop && (
          <>
            <DropdownMenuSeparator role="separator" />
            <DropdownMenuItem
              aria-label={nextLocale.action}
              onClick={() => setLocale(nextLocale.value)}
            >
              <Globe size={18} className="size-[18px]" aria-hidden="true" />
              <span lang={nextLocale.lang}>{nextLocale.label}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator role="separator" />
            {appearanceItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const links = (groups: number[]) => (
    <NavigationGroup activeHref={active && groups.includes(active.group) ? active.href : undefined}>
      {navigation.filter((n) => groups.includes(n.group)).map((n) => (
        <NavigationHint key={n.href} label={n.label}>
          <Link
            href={n.href}
            aria-label={n.label}
            aria-current={active?.href === n.href ? "page" : undefined}
            className={railLink}
          >
            <NavigationIcon icon={n.icon} />
          </Link>
        </NavigationHint>
      ))}
    </NavigationGroup>
  );
  const searchTrigger = (className: string, position: "bottom-end" | "right") => (
    <Tip
      label={<><span aria-hidden="true">{t("搜索", "Search")}</span>{os !== "undetermined" && <kbd>{appleKeyboard ? "⌘ K" : "Ctrl K"}</kbd>}</>}
      position={position}
      offset={position === "right" ? 12 : 8}
    >
      <Button
        className={className}
        variant="ghost"
        size="icon"
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
        <Search size={20} aria-hidden="true" />
      </Button>
    </Tip>
  );
  return (
    <div className={desktop ? "mx-app mx-desktop-app" : "mx-app"} data-assistant-open={assistant.open || undefined}>
      <Suspense fallback={null}><SearchRouteObserver onChange={setRouteSearch} /></Suspense>
      <a className="mx-skip" href="#main-content" inert={assistantOverlay || undefined}>
        {t("跳到正文", "Skip to content")}
      </a>
      <aside className="mx-sidebar" inert={assistantOverlay || undefined}>
        <Link
          href="/"
          className={buttonVariants({ variant: "ghost", size: "icon", className: "mx-brand" })}
          aria-label={t("Trading Max · 组合总览", "Trading Max · Overview")}
        >
          <BrandMark size={32} className="mx-brand-symbol" />
        </Link>
        {desktop && searchTrigger("mx-sidebar-search", "right")}
        <nav aria-label={t("主导航", "Primary navigation")}>
          {links([0, 1])}
        </nav>
        <div className="mx-sidebar-bottom">
          {desktop ? <DesktopStatus localWorkspace={localWorkspace} demonstration={demonstration} /> : <nav aria-label={t("工作区管理", "Workspace management")}>
            {links([2])}
          </nav>}
        </div>

      </aside>
      <div className="mx-content" inert={assistantOverlay || undefined}>
        <header className="mx-topbar" ref={topbarRef}>
          <div className="mx-topbar-title">
            <span className="mx-topbar-workspace">
              {profile.data?.displayName ||
                t("工作区", "Workspace")}
            </span>
            <span className="mx-breadcrumb-divider" aria-hidden="true">/</span>
            <strong>{active?.label}</strong>
          </div>
          <div className="mx-topbar-actions">
            {demonstration && <Tag>{t("演示数据", "Demo data")}</Tag>}
            <AssistantEntry />
            {searchTrigger("mx-topbar-search", "bottom-end")}
            {/* In the App, language lives in workspace preferences and appearance follows macOS. */}
            {!desktop && <Button
              className="mx-topbar-preference"
              variant="ghost"
              size="icon"
              aria-label={nextLocale.action}
              onClick={() => setLocale(nextLocale.value)}
            >
              <Globe size={20} aria-hidden="true" />
            </Button>}
            {!desktop && theme}
            {more}
          </div>
        </header>
        <main id="main-content" tabIndex={-1} onFocus={revealPageFocus}>
          {children}
        </main>
      </div>
      <AssistantPanel overlay={compactAssistant} page={active?.href.slice(1) || "overview"} scopeLabel={active?.label ?? t("工作区", "Workspace")} searchOpen={searchOpen} />
      <nav inert={assistantOverlay || undefined}
        className="mx-mobile-dock"
        ref={dockRef}
        aria-label={t("快捷导航", "Quick navigation")}
      >
        <NavigationGroup activeHref={active && active.group < 2 ? active.href : undefined}>
        {navigation
          .filter((n) => n.group < 2)
          .map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={buttonVariants({ variant: "ghost", className: "mx-mobile-dock-link" })}
              aria-current={active?.href === n.href ? "page" : undefined}
            >
              <NavigationIcon icon={n.icon} />
              <span>{n.mobileLabel}</span>
            </Link>
          ))}
        </NavigationGroup>
      </nav>
      <WorkspaceDialog
        open={searchOpen}
        onClose={closeSearch}
        finalFocus={false}
        onClosed={() => {
          setQuery("");
          setIndex(0);
        }}
        title={t("搜索", "Search")}
        hideClose
        className="mx-command-dialog" headerClassName="sr-only" bodyClassName="mx-search-body"
        width={600}
      >
        <StatusMessage message={directoryMessage} />
        <div className="mx-search-row" role="search" aria-label={t("搜索", "Search")}>
          <InputGroup>
            <InputGroupAddon aria-hidden="true"><Search size={20} /></InputGroupAddon>
            <InputGroupInput
              {...searchInputHints}
              name="q"
              data-autofocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={searchId + "-results"}
              aria-activedescendant={results[selectedIndex] ? searchId + "-" + selectedIndex : undefined}
              aria-label={t("搜索", "Search")}
              placeholder={t("页面、代码或名称", "Page, ticker or name")}
              value={query}
              maxLength={160}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
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
          </InputGroup>
          <CloseButton className="mx-search-close" iconSize={18} aria-label={t("关闭", "Close")} onClick={closeSearch} />
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
        {match && results.every((item) => item.group === "holdings") && catalogsReady && !directory.isFetching && !indexCatalog.isFetching && !directoryOffline && !needsSecurity(query, currentTicker) && (
          <p className="mx-command-status" role="status">{t("没有找到“", "No results for “") + query.trim() + "”"}</p>
        )}
        {directoryIssue ? (
          <div className="mx-command-status">
            <span>{directoryIssue}</span>
            {(researchFailed || indexFailed) && !directoryOffline && <Button variant="ghost" onClick={() => {
              if (researchFailed) void directory.refetch();
              if (indexFailed) void indexCatalog.refetch();
            }}>
              {t("重试", "Retry")}
            </Button>}
          </div>
        ) : catalogPending ? (
          <p className="mx-command-status">{directoryLoading}</p>
        ) : null}
        {!match && recent.length > 0 && <div className="mx-command-recent-actions"><button type="button" className="mx-command-clear" onClick={() => setHistory((previous) => ({ ...previous, items: [] }))}>{t("清除最近访问", "Clear recent")}</button></div>}
        <div className="mx-command-footer">
          <span>{t("↑ ↓ 选择 · Enter 打开", "↑ ↓ navigate · Enter open")}</span>
          <span>Esc {t("关闭", "close")}</span>
        </div>
      </WorkspaceDialog>
    </div>
  );
}
