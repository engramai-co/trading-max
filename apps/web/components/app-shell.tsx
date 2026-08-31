"use client";

import {
  ActionIcon,
  AppShell as MantineAppShell,
  Box,
  Group,
  Image,
  Menu,
  NavLink,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from "@mantine/core";
import {
  ChartLineUp,
  Check,
  CircleHalf,
  ClockCounterClockwise,
  Flask,
  GearSix,
  Heartbeat,
  House,
  Moon,
  Sun,
  Wallet,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";

import { useLocale, useMessages } from "@/components/locale-provider";
import { preloadEChartsRuntime } from "@/ui/charts/use-echarts";

const primaryNavigation = [
  { href: "/", key: "overview", icon: House },
  { href: "/holdings", key: "holdings", icon: Wallet },
  { href: "/analytics", key: "analytics", icon: ChartLineUp },
  { href: "/review", key: "review", icon: ClockCounterClockwise },
  { href: "/research", key: "research", icon: Flask },
] as const;

const operationsNavigation = [
  { href: "/health", key: "health", icon: Heartbeat },
  { href: "/settings", key: "settings", icon: GearSix },
] as const;

const stagedPrefetchRoutes = ["/holdings", "/analytics", "/review", "/research"] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { locale } = useLocale();
  const messages = useMessages();
  const prefetchRoute = useCallback((href: string) => {
    router.prefetch(href);
    if (href === "/analytics") void preloadEChartsRuntime("core");
    if (href === "/research") void preloadEChartsRuntime("research");
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    let delayId: number | undefined;
    let idleId: number | undefined;
    let observer: MutationObserver | undefined;

    const prefetchFrequentRoutes = () => {
      if (cancelled) return;
      idleId = window.requestIdleCallback(() => {
        if (cancelled) return;
        for (const href of stagedPrefetchRoutes) {
          if (href !== pathname) router.prefetch(href);
        }
      }, { timeout: 1_000 });
    };

    const schedulePrefetch = () => {
      delayId = window.setTimeout(prefetchFrequentRoutes, pathname === "/" ? 350 : 700);
    };

    if (pathname.startsWith("/analytics") && !document.querySelector("[data-tm-chart-ready='true']")) {
      observer = new MutationObserver(() => {
        if (!document.querySelector("[data-tm-chart-ready='true']")) return;
        observer?.disconnect();
        schedulePrefetch();
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    } else {
      schedulePrefetch();
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (delayId !== undefined) window.clearTimeout(delayId);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
    };
  }, [pathname, router]);

  return (
    <MantineAppShell
      header={{ height: { base: 64, sm: 0 } }}
      navbar={{
        width: 72,
        breakpoint: "sm",
        collapsed: { mobile: true },
      }}
      footer={{ height: { base: 72, sm: 0 } }}
      padding={{ base: "md", sm: "xl" }}
      transitionDuration={220}
      transitionTimingFunction="var(--tm-ease-drawer)"
      styles={{
        footer: { background: "var(--tm-surface)", borderColor: "var(--tm-border)" },
        header: { background: "var(--tm-surface)", borderColor: "var(--tm-border)" },
        main: { background: "var(--tm-canvas)" },
        navbar: { background: "var(--tm-surface)", borderColor: "var(--tm-border)" },
      }}
    >
      <a className="skip-link" href="#main-content">
        {locale === "zh" ? "跳到主要内容" : "Skip to main content"}
      </a>

      <MantineAppShell.Header hiddenFrom="sm" px="md">
        <Group h="100%" justify="space-between">
          <Brand compact />
          <Group gap={4} wrap="nowrap">
            <ThemeMenu />
            <ActionIcon
              aria-label={messages.nav.settings}
              component={Link}
              href="/settings"
              onFocus={() => prefetchRoute("/settings")}
              onMouseEnter={() => prefetchRoute("/settings")}
              onPointerDown={() => prefetchRoute("/settings")}
              prefetch={false}
              size={44}
              variant={pathname.startsWith("/settings") ? "light" : "subtle"}
            >
              <GearSix size={20} weight={pathname.startsWith("/settings") ? "fill" : "regular"} />
            </ActionIcon>
          </Group>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar
        className="tm-desktop-navbar"
        id="tm-primary-navigation"
        p="sm"
      >
        <Stack h="100%" gap="sm">
          <Box className="tm-desktop-brand">
            <Brand compact rail />
          </Box>
          <Stack component="nav" gap={2} aria-label={messages.nav.primaryNavigation}>
            {primaryNavigation.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : item.href === "/review"
                    ? pathname.startsWith("/review") || pathname.startsWith("/account-analysis")
                    : pathname.startsWith(item.href);
              const Icon = item.icon;
              return <DesktopNavigationLink
                active={active}
                href={item.href}
                icon={<Icon size={20} weight={active ? "fill" : "regular"} />}
                key={item.href}
                label={messages.nav[item.key]}
                onPrefetch={prefetchRoute}
              />;
            })}
          </Stack>
          <Box flex={1} />
          <ThemeMenu rail />
          <Stack
            component="nav"
            gap={2}
            aria-label={locale === "zh" ? "系统操作" : "System operations"}
          >
            {operationsNavigation.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return <DesktopNavigationLink
                active={active}
                href={item.href}
                icon={<Icon size={20} weight={active ? "fill" : "regular"} />}
                key={item.href}
                label={messages.nav[item.key]}
                onPrefetch={prefetchRoute}
              />;
            })}
          </Stack>
        </Stack>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="tm-main-shell" id="main-content" pb={{ base: "calc(72px + env(safe-area-inset-bottom))", sm: 0 }} tabIndex={-1}>
        <Box className="tm-main-frame" maw={1920} mx="auto">
          {children}
        </Box>
      </MantineAppShell.Main>

      <MantineAppShell.Footer hiddenFrom="sm" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <Group
          aria-label={messages.nav.mobileNavigation}
          component="nav"
          gap={2}
          h="100%"
          justify="space-around"
          px={4}
          wrap="nowrap"
        >
          {primaryNavigation.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : item.href === "/review"
                  ? pathname.startsWith("/review") || pathname.startsWith("/account-analysis")
                  : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <UnstyledButton
                aria-current={active ? "page" : undefined}
                className="tm-mobile-nav-link"
                component={Link}
                data-active={active || undefined}
                href={item.href}
                key={item.href}
                onFocus={() => prefetchRoute(item.href)}
                onPointerDown={() => prefetchRoute(item.href)}
                prefetch={false}
              >
                <Stack align="center" gap={2} h="100%" justify="center">
                  <Icon size={20} weight={active ? "fill" : "regular"} />
                  <Text c={active ? "brand.8" : "dimmed"} fw={active ? 700 : 600} size="10px">
                    {messages.nav[item.key]}
                  </Text>
                </Stack>
              </UnstyledButton>
            );
          })}
        </Group>
      </MantineAppShell.Footer>
    </MantineAppShell>
  );
}

function ThemeMenu({ rail = false }: { rail?: boolean }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme({ keepTransitions: true });
  const { locale } = useLocale();
  const options = [
    {
      icon: Sun,
      label: locale === "zh" ? "浅色" : "Light",
      value: "light" as const,
    },
    {
      icon: Moon,
      label: locale === "zh" ? "深色" : "Dark",
      value: "dark" as const,
    },
    {
      icon: CircleHalf,
      label: locale === "zh" ? "跟随系统" : "System",
      value: "auto" as const,
    },
  ];
  const label = locale === "zh" ? "外观主题" : "Appearance theme";

  return (
    <Menu
      position={rail ? "right-end" : "bottom-end"}
      shadow="md"
      trapFocus={false}
      width={176}
      withInitialFocusPlaceholder={false}
      withinPortal={false}
    >
      <Menu.Target>
        <ActionIcon
          aria-label={label}
          className="tm-theme-trigger"
          size={44}
          title={label}
          variant="subtle"
        >
          <CircleHalf aria-hidden="true" size={22} weight="fill" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <Menu.Item
              aria-label={colorScheme === option.value
                ? `${option.label}，${locale === "zh" ? "当前" : "selected"}`
                : option.label}
              key={option.value}
              leftSection={<Icon aria-hidden="true" size={18} />}
              onClick={() => setColorScheme(option.value)}
              rightSection={colorScheme === option.value ? <Check aria-hidden="true" size={16} weight="bold" /> : null}
            >
              {option.label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

function DesktopNavigationLink({
  active,
  href,
  icon,
  label,
  onPrefetch,
}: {
  active: boolean;
  href: string;
  icon: React.ReactNode;
  label: string;
  onPrefetch: (href: string) => void;
}) {
  const link = (
    <NavLink
      active={active}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className="tm-desktop-nav-link"
      component={Link}
      href={href}
      label={null}
      leftSection={icon}
      onFocus={() => onPrefetch(href)}
      onMouseEnter={() => onPrefetch(href)}
      onPointerDown={() => onPrefetch(href)}
      prefetch={false}
      styles={{
        body: { display: "none" },
        root: {
          justifyContent: "center",
          minHeight: 44,
          minWidth: 48,
          paddingInline: 14,
          width: 48,
        },
        section: { marginInlineEnd: 0 },
      }}
    />
  );
  return (
    <Tooltip label={label} openDelay={350} position="right">
      {link}
    </Tooltip>
  );
}

function Brand({ compact = false, rail = false }: { compact?: boolean; rail?: boolean }) {
  return (
    <Link
      aria-label="Trading Max"
      className="tm-brand-link"
      href="/"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <Group gap={rail ? 8 : "sm"} wrap="nowrap">
        <Image
          alt=""
          fit="contain"
          h={rail ? 32 : compact ? 36 : 44}
          src="/brand/trading-max-symbol.svg"
          w={rail ? 34 : compact ? 38 : 46}
        />
        {rail ? null : (
          <Stack gap={0}>
            <Text
              ff="var(--mantine-font-family-headings)"
              fw={800}
              lh={1}
              style={{ whiteSpace: "nowrap" }}
            >
              Trading Max
            </Text>
            {!compact ? (
              <Text c="dimmed" fw={600} size="10px" tt="uppercase">
                Portfolio intelligence
              </Text>
            ) : null}
          </Stack>
        )}
      </Group>
    </Link>
  );
}
