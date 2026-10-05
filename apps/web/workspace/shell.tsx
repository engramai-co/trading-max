"use client";

import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Menu,
  Modal,
  TextInput,
  Tooltip,
  VisuallyHidden,
  useMantineColorScheme,
} from "@mantine/core";
import { useOs } from "@mantine/hooks";
import {
  ArrowRight,
  ChartBar,
  ChartLine,
  ChartPieSlice,
  Check,
  CircleHalf,
  ClockCounterClockwise,
  GearSix,
  Globe,
  List,
  MagnifyingGlass,
  Moon,
  SquaresFour,
  StackSimple,
  Sun,
  X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import Link from "./link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { ResearchShell } from "@/lib/types";
import { api } from "@/workspace/data";
import { useWorkspaceProfile } from "./profile";
import { useCopy } from "./foundation";

import { desktopPage, presentationLink } from "./desktop-routing";
import { DesktopStatus } from "./desktop-surfaces";
import { NavigationGroup, NavigationHint, NavigationIcon } from "./navigation-group";
import { highlightParts, needsSecurity, pageAliases, recentVisit, rememberVisit, searchWorkspace, type SearchResult } from "./command-search";

function SearchHighlight({ text, query }: { text: string; query: string }) {
  return highlightParts(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>);
}

function SearchRouteObserver({ onChange }: { onChange: (search: string) => void }) {
  const params = useSearchParams();
  const search = params.toString();
  useEffect(() => onChange(search), [onChange, search]);
  return null;
}

export function WorkspaceShell({ children, desktop = false, localWorkspace = false }: { children: React.ReactNode; desktop?: boolean; localWorkspace?: boolean }) {
  const t = useCopy();
  const actualPathname = usePathname();
  const [routeSearch, setRouteSearch] = useState("");
  const params = new URLSearchParams(routeSearch);
  const pathname = desktop ? "/" + (desktopPage(actualPathname) ?? "") : actualPathname;
  const profile = useWorkspaceProfile();
  const router = useRouter();
  const { locale, setLocale } = useLocale();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const os = useOs();
  const appleKeyboard = os === "macos" || os === "ios";
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
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
      mobileLabel: t("总览", "Overview"),
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
      href: "/research",
      label: t("证券研究", "Research"),
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
      mobileLabel: t("状态", "Data status"),
      icon: StackSimple,
      group: 2,
    },
    {
      href: "/settings",
      label: t("设置与连接", "Connections"),
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
          setMobileOpen(false);
          if (!searchOpen) searchOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          restoreSearchFocus.current = searchOpen;
          setSearchOpen(!searchOpen);
        }
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [searchOpen]);
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
    queryKey: ["workspace-research-shell"],
    queryFn: ({ signal }) => api<ResearchShell>("/research/shell", { signal }),
    enabled: searchOpen,
    staleTime: 60_000,
    retry: 0,
  });
  const match = query.trim().toLowerCase();
  const pages = navigation.map((item) => ({ href: item.href, label: item.label, aliases: pageAliases[item.href] }));
  const profileId = profile.data?.profileId ?? null;
  const visit = recentVisit(pathname, new URLSearchParams(routeSearch), pages, locale);
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
    return recentVisit(url.pathname, url.searchParams, pages, locale) ?? item;
  }) : [];
  const currentTicker = pathname === "/research" ? params.get("ticker") : null;
  const results = [
    ...searchWorkspace({ query, pages, instruments: directory.data?.instruments ?? [], recent, currentTicker, locale })
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
  ];
  const selectedIndex = Math.min(index, Math.max(0, results.length - 1));
  const groups = { recent: t("最近访问", "Recent"), pages: t("页面", "Pages"), research: t("研究清单", "Research list"), holdings: t("持仓搜索", "Search holdings") };
  useEffect(() => {
    if (searchOpen) resultsRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query, searchOpen, results.length]);
  function navigate(href: string) {
    restoreSearchFocus.current = false;
    setSearchOpen(false);
    setMobileOpen(false);
    const route = presentationLink(actualPathname, href);
    if (route.separate) window.open(route.href, "_blank", "noopener");
    else router.push(route.href);
  }
  const brand = (
    <Link
      href="/"
      className="mx-brand"
      aria-label={t("Trading Max · 组合总览", "Trading Max · Overview")}
      onClick={() => setMobileOpen(false)}
    >
      <Image
        src="/brand/trading-max-app-icon.svg"
        alt=""
        width={36}
        height={36}
        className="mx-brand-symbol"
        priority
      />
      <span>
        Trading<span className="mx-brand-max">Max</span>
      </span>
    </Link>
  );
  const theme = (
    <Menu position="bottom-end" shadow="md" width={190}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          aria-label={t("选择外观", "Choose appearance")}
        >
          <CircleHalf size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(
          [
            { value: "light", label: t("浅色", "Light"), Icon: Sun },
            { value: "dark", label: t("深色", "Dark"), Icon: Moon },
            { value: "auto", label: t("跟随系统", "System"), Icon: CircleHalf },
          ] as const
        ).map((item) => (
          <Menu.Item
            key={item.value}
            onClick={() => setColorScheme(item.value)}
            leftSection={<item.Icon size={17} />}
            rightSection={colorScheme === item.value && <Check size={15} />}
          >
            {item.label}
          </Menu.Item>
        ))}
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
          onClick={() => setMobileOpen(false)}
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
  return (
    <div className={desktop ? "mx-app mx-desktop-app" : "mx-app"} inert={searchOpen || mobileOpen}>
      <Suspense fallback={null}><SearchRouteObserver onChange={setRouteSearch} /></Suspense>
      <a className="mx-skip" href="#main-content">
        {t("跳到正文", "Skip to content")}
      </a>
      <Drawer.Root
        opened={mobileOpen}
        onClose={() => setMobileOpen(false)}
        size="100%"
        position="bottom"
        transitionProps={{ duration: 0 }}
      >
        <Drawer.Overlay />
        <Drawer.Content classNames={{ content: "mx-mobile-menu" }}>
          <Drawer.Header className="mx-mobile-menu-header">
            <VisuallyHidden component={Drawer.Title}>
              {t("工作台导航", "Workspace navigation")}
            </VisuallyHidden>
            <div className="mx-drawer-brand">{brand}</div>
            <Drawer.CloseButton aria-label={t("关闭导航", "Close navigation")} />
          </Drawer.Header>
          <Drawer.Body className="mx-mobile-menu-body">
            <nav
              className="mx-drawer-nav"
              aria-label={t("移动端导航", "Mobile navigation")}
            >
              {links([0, 1])}
              {links([2])}
            </nav>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
      <aside className="mx-sidebar">
        <Tooltip.Group openDelay={250} closeDelay={100}>
        {brand}
        <nav aria-label={t("主导航", "Primary navigation")}>
          {links([0, 1], true)}
        </nav>
        <div className="mx-sidebar-bottom">
          {desktop ? <DesktopStatus localWorkspace={localWorkspace} /> : <nav aria-label={t("工作台管理", "Workspace management")}>
            {links([2], true)}
          </nav>}
        </div>
        </Tooltip.Group>
      </aside>
      <div className="mx-content">
        <header className="mx-topbar">
          <div className="mx-topbar-title">
            <ActionIcon
              className="mx-menu-toggle"
              aria-label={
                mobileOpen
                  ? t("关闭导航", "Close navigation")
                  : t("打开导航", "Open navigation")
              }
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((open) => !open)}
            >
              {mobileOpen ? <X size={21} /> : <List size={21} />}
            </ActionIcon>
            <span className="mx-topbar-workspace">
              {profile.data?.displayName ||
                t("工作台", "Workspace")}
            </span>
            <span className="mx-breadcrumb-divider">/</span>
            <strong>{active?.label}</strong>
          </div>
          <Group gap={4} wrap="nowrap">
            <Tooltip
              label={<span className="mx-nav-search-hint">{t("搜索", "Search")}{os !== "undetermined" && <kbd>{appleKeyboard ? "⌘ K" : "Ctrl K"}</kbd>}</span>}
              position="bottom-end"
              offset={8}
              openDelay={250}
              classNames={{ tooltip: "mx-nav-tooltip" }}
              transitionProps={{ duration: 0 }}
              events={{ hover: true, focus: true, touch: false }}
              interactive
            >
            <ActionIcon
              className="mx-topbar-search"
              variant="subtle"
              data-search-trigger
              aria-label={t("搜索页面或证券", "Search pages or securities")}
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              aria-keyshortcuts={appleKeyboard ? "Meta+K" : "Control+K"}
              onClick={(event) => {
                searchOpener.current = event.currentTarget;
                restoreSearchFocus.current = false;
                setSearchOpen(true);
                setMobileOpen(false);
              }}
            >
              <MagnifyingGlass size={19} aria-hidden="true" />
            </ActionIcon>
            </Tooltip>
            <ActionIcon
              aria-label={locale === "zh" ? "Switch to English" : "切换到中文"}
              onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            >
              <Globe size={19} />
            </ActionIcon>
            {theme}
          </Group>
        </header>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav
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
        classNames={{ content: "mx-command-dialog" }}
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
        title={t("搜索页面或证券", "Search pages or securities")}
        size={600}
      >
        <TextInput
          data-autofocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={searchId + "-results"}
          aria-activedescendant={results[selectedIndex] ? searchId + "-" + selectedIndex : undefined}
          aria-label={t("搜索页面或证券", "Search pages or securities")}
          placeholder={t(
            "输入页面名称、代码或公司名…",
            "Page, ticker, or company…",
          )}
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
              navigate(results[selectedIndex].href);
            }
          }}
        />
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
                onClick={() => navigate(item.href)}
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
          <p className="mx-command-status" role="status">{t("加上证券代码，例如 ARM 技术面。", "Include a ticker, such as ARM technical.")}</p>
        )}
        {match && results.every((item) => item.group === "holdings") && !directory.isFetching && !needsSecurity(query, currentTicker) && (
          <p className="mx-command-status" role="status">{t("没有匹配的页面或证券。", "No matching pages or securities.")}</p>
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
