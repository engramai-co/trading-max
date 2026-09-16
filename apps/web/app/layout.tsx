import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import type { Metadata, Viewport } from "next";

import { WorkspaceShell } from "@/workspace/shell";
import { LocaleProvider } from "@/components/locale-provider";
import { TradingMaxProvider } from "@/ui/provider";
import { brandColours, darkCanvas } from "@/ui/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Trading Max Portfolio",
    template: "%s · Trading Max",
  },
  description: "Portfolio analytics and security research.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { color: brandColours[0], media: "(prefers-color-scheme: light)" },
    { color: darkCanvas, media: "(prefers-color-scheme: dark)" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      data-locale="zh"
      data-scroll-behavior="smooth"
      {...mantineHtmlProps}
    >
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <TradingMaxProvider>
          <LocaleProvider>
            <WorkspaceShell>{children}</WorkspaceShell>
          </LocaleProvider>
        </TradingMaxProvider>
      </body>
    </html>
  );
}
