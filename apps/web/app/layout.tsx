import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { ColorSchemeScript } from "@/components/color-scheme-script";
import { colorSchemeHtmlProps, DEFAULT_COLOR_SCHEME } from "@/lib/color-scheme";
import { desktopSnapshotCache, snapshotCacheScope } from "@/lib/snapshot-cache-server";

import { PresentationShell } from "@/workspace/presentation-shell";
import { LocaleProvider } from "@/components/locale-provider";
import { TradingMaxProvider } from "@/ui/provider";
import { darkCanvas, tradingMaxTheme } from "@/ui/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Trading Max",
    template: "%s · Trading Max",
  },
  description: "Portfolio analytics and investment research.",
  // iOS ignores SVG touch icons and reads the home-screen title from this metadata. Declaring icons here
  // replaces the file-based app/icon.svg link, so the browser icon is listed explicitly too.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml", sizes: "any" }],
    apple: [{ url: "/brand/trading-max-apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Trading Max",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await connection();
  const scope = snapshotCacheScope();
  const desktopCache = await desktopSnapshotCache(scope);
  return (
    <html
      lang="zh-CN"
      data-locale="zh"
      data-scroll-behavior="smooth"
      data-respect-reduced-motion={tradingMaxTheme.respectReducedMotion ? "true" : undefined}
      {...colorSchemeHtmlProps}
    >
      <head>
        {/* React hoists and matches meta elements by content. Keep the paint-time
            hints outside that reconciliation so hydration cannot duplicate them. */}
        <noscript dangerouslySetInnerHTML={{
          __html: `<meta name="color-scheme" content="light dark"><meta name="theme-color" content="${darkCanvas}">`,
        }} />
        <ColorSchemeScript defaultColorScheme={DEFAULT_COLOR_SCHEME} />
      </head>
      <body>
        <TradingMaxProvider key={scope} scope={scope} desktopCache={desktopCache}>
          <LocaleProvider>
            <PresentationShell localWorkspace={Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID)} demonstration={process.env.TRADING_MAX_ENV === "desktop-preview"}>{children}</PresentationShell>
          </LocaleProvider>
        </TradingMaxProvider>
      </body>
    </html>
  );
}
