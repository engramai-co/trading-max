"use client";

import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Menu,
  Modal,
  TextInput,
  VisuallyHidden,
  useMantineColorScheme,
} from "@mantine/core";
import { useOs } from "@mantine/hooks";
import {
  ArrowRight,
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
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { ResearchShell } from "@/lib/types";
import { api } from "@/workspace/data";
import { useWorkspaceProfile } from "./profile";
import { useCopy } from "./foundation";

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const t = useCopy();
  const pathname = usePathname();
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
  const resultsRef = useRef<HTMLDivElement>(null);
  const navigation = [
    {
      href: "/",
      label: t("组合总览", "Overview"),
      icon: SquaresFour,
      group: 0,
      hint: t("组合资产", "portfolio overview "),
    },
    {
      href: "/holdings",
      label: t("持仓与穿透", "Holdings"),
      icon: ChartPieSlice,
      group: 0,
      hint: t("持仓配置", "positions allocation "),
    },
    {
      href: "/analytics",
      label: t("收益与风险", "Performance"),
      icon: ChartLine,
      group: 0,
      hint: t("收益风险", "performance returns "),
    },
    {
      href: "/research",
      label: t("证券研究", "Research"),
      icon: MagnifyingGlass,
      group: 1,
      hint: t("证券研究", "research securities "),
    },
    {
      href: "/review",
      label: t("投资复盘", "Review"),
      icon: ClockCounterClockwise,
      group: 1,
      hint: t("交易复盘", "history trades "),
    },
    {
      href: "/health",
      label: t("数据状态", "Data status"),
      icon: StackSimple,
      group: 2,
      hint: t("数据状态更新", "health sync "),
    },
    {
      href: "/settings",
      label: t("设置与连接", "Connections"),
      icon: GearSix,
      group: 2,
      hint: t("设置连接", "settings integrations "),
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
          setSearchOpen((open) => !open);
        }
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  useEffect(() => {
    if (searchOpen) {
      resultsRef.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [index, query, searchOpen]);
  const directory = useQuery({
    queryKey: ["workspace-search"],
    queryFn: () => api<ResearchShell>("/research/shell"),
    enabled: searchOpen,
    staleTime: 60_000,
    retry: 0,
  });
  const match = query.trim().toLowerCase();
  const results = [
    ...navigation
      .filter(
        (n) =>
          !match || (n.label + n.hint + n.href).toLowerCase().includes(match),
      )
      .map((n) => ({
        href: n.href,
        label: n.label,
        detail: null,
        group: t("页面", "Pages"),
        Icon: n.icon,
      })),
    ...(directory.data?.instruments ?? [])
      .filter(
        (i) => !match || (i.ticker + i.name).toLowerCase().includes(match),
      )
      .slice(0, 8)
      .map((i) => ({
        href: "/research?ticker=" + encodeURIComponent(i.ticker),
        label: i.ticker,
        detail: i.name,
        group: t("研究清单", "Research list"),
        Icon: MagnifyingGlass,
      })),
    ...(match
      ? [
          {
            href: "/holdings?q=" + encodeURIComponent(query.trim()),
            label:
              t("在持仓中搜索", "Search holdings") + " “" + query.trim() + "”",
            detail: null,
            group: null,
            Icon: ChartPieSlice,
          },
        ]
      : []),
  ];
  function navigate(href: string) {
    setSearchOpen(false);
    setMobileOpen(false);
    router.push(href);
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
  const links = (group: number) =>
    navigation
      .filter((n) => n.group === group)
      .map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={active?.href === n.href ? "page" : undefined}
          className="mx-nav-link"
          onClick={() => setMobileOpen(false)}
        >
          <n.icon
            size={20}
            weight={active?.href === n.href ? "fill" : "regular"}
          />
          <span>{n.label}</span>
          {active?.href === n.href && <span className="mx-nav-current" />}
        </Link>
      ));
  return (
    <div className="mx-app" inert={searchOpen || mobileOpen}>
      <a className="mx-skip" href="#main-content">
        {t("跳到正文", "Skip to content")}
      </a>
      <Drawer.Root
        opened={mobileOpen}
        onClose={() => setMobileOpen(false)}
        size={300}
        position="left"
      >
        <Drawer.Overlay />
        <Drawer.Content>
          <Drawer.Header>
            <VisuallyHidden component={Drawer.Title}>
              {t("工作台导航", "Workspace navigation")}
            </VisuallyHidden>
            <div className="mx-drawer-brand">{brand}</div>
            <Drawer.CloseButton aria-label={t("关闭导航", "Close navigation")} />
          </Drawer.Header>
          <Drawer.Body>
            <nav
              className="mx-drawer-nav"
              aria-label={t("移动端导航", "Mobile navigation")}
            >
              {links(0)}
              {links(1)}
              {links(2)}
            </nav>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
      <aside className="mx-sidebar">
        {brand}
        <button
          className="mx-search-trigger"
          aria-label={t("搜索页面或证券", "Search pages or securities")}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          aria-keyshortcuts={appleKeyboard ? "Meta+K" : "Control+K"}
          onClick={() => {
            setSearchOpen(true);
            setMobileOpen(false);
          }}
        >
          <MagnifyingGlass size={17} />
          <span>{t("搜索", "Search")}</span>
          {os !== "undetermined" && (
            <kbd aria-hidden="true">{appleKeyboard ? "⌘ K" : "Ctrl K"}</kbd>
          )}
        </button>
        <nav aria-label={t("主导航", "Primary navigation")}>
          <div className="mx-nav-label">{t("我的组合", "MY PORTFOLIO")}</div>
          {links(0)}
          <div className="mx-nav-label">
            {t("研究与复盘", "RESEARCH & REVIEW")}
          </div>
          {links(1)}
        </nav>
        <div className="mx-sidebar-bottom">
          <nav aria-label={t("工作台管理", "Workspace management")}>
            {links(2)}
          </nav>
        </div>
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
            <ActionIcon
              className="mx-mobile-search"
              aria-label={t("搜索页面或证券", "Search pages or securities")}
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              aria-keyshortcuts={appleKeyboard ? "Meta+K" : "Control+K"}
              onClick={() => setSearchOpen(true)}
            >
              <MagnifyingGlass size={19} />
            </ActionIcon>
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
        {navigation
          .filter((n) => n.group < 2)
          .map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active?.href === n.href ? "page" : undefined}
            >
              <n.icon
                size={21}
                weight={active?.href === n.href ? "fill" : "regular"}
              />
              <span>{n.label}</span>
            </Link>
          ))}
      </nav>
      <Modal
        opened={searchOpen}
        onClose={() => setSearchOpen(false)}
        zIndex={1100}
        closeOnEscape={false}
        // Mantine drawers listen during window capture. Mark the focused target
        // before Escape reaches them; this dialog alone handles its close.
        onFocusCapture={(event) => event.target.setAttribute("data-mantine-stop-propagation", "true")}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(false);
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
          aria-label={t("搜索页面或证券", "Search pages or securities")}
          placeholder={t(
            "输入页面名称、代码或公司名…",
            "Page, ticker, or company…",
          )}
          leftSection={<MagnifyingGlass size={20} />}
          value={query}
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
                    i + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (event.key === "Enter" && results[index]) {
              event.preventDefault();
              navigate(results[index].href);
            }
          }}
        />
        <div className="mx-command-results" ref={resultsRef}>
          {results.map((item, i) => (
            <Fragment key={item.href}>
              {item.group && item.group !== results[i - 1]?.group && (
                <h3 className="mx-command-group">{item.group}</h3>
              )}
              {!item.group && i > 0 && (
                <div className="mx-command-divider" aria-hidden="true" />
              )}
              <button
                className="mx-command-result"
                data-active={i === index || undefined}
                onClick={() => navigate(item.href)}
                onFocus={() => setIndex(i)}
              >
                <item.Icon size={20} />
                <span>
                  <strong>{item.label}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </span>
                <ArrowRight size={16} />
              </button>
            </Fragment>
          ))}
        </div>
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
        <div className="mx-command-footer">
          <span>{t("↑ ↓ 选择 · Enter 打开", "↑ ↓ navigate · Enter open")}</span>
          <span>Esc {t("关闭", "close")}</span>
        </div>
      </Modal>
    </div>
  );
}
