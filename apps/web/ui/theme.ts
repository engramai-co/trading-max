import { createTheme } from "@mantine/core";

export const brandColours = [
  "#edf5ff",
  "#d9e8ff",
  "#aecfff",
  "#7eb3ff",
  "#559aff",
  "#3888ff",
  "#247eff",
  "#1768e5",
  "#1254bc",
  "#113f8f",
] as const;
export const darkCanvas = "#0b1220";
export const tradingMaxTheme = createTheme({
  primaryColor: "brand",
  autoContrast: true,
  primaryShade: { light: 7, dark: 7 },
  colors: { brand: [...brandColours] },
  black: "#111827",
  white: "#ffffff",
  defaultRadius: "md",
  cursorType: "pointer",
  respectReducedMotion: true,
  fontFamily:
    '"Avenir Next", Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif',
  fontFamilyMonospace: '"SFMono-Regular", Consolas, monospace',
  fontSizes: {
    xs: "0.75rem",
    sm: "0.8125rem",
    md: "0.9375rem",
    lg: "1.0625rem",
    xl: "1.25rem",
  },
  headings: {
    fontFamily: "inherit",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "2rem", lineHeight: "1.2" },
      h2: { fontSize: "1.25rem", lineHeight: "1.4" },
      h3: { fontSize: "1rem", lineHeight: "1.4" },
    },
  },
  radius: { xs: "4px", sm: "7px", md: "10px", lg: "14px", xl: "20px" },
  spacing: { xs: "6px", sm: "10px", md: "16px", lg: "24px", xl: "32px" },
  shadows: {
    xs: "0 1px 2px rgba(17,24,39,.03)",
    sm: "0 4px 16px rgba(17,24,39,.06)",
    md: "0 12px 32px rgba(17,24,39,.10)",
    lg: "0 24px 64px rgba(17,24,39,.14)",
    xl: "0 32px 80px rgba(17,24,39,.18)",
  },
  components: {
    Button: {
      defaultProps: { size: "sm", radius: "sm" },
      styles: { root: { minHeight: 40, fontWeight: 600 } },
    },
    ActionIcon: { defaultProps: { size: 40, radius: "sm", variant: "subtle" } },
    TextInput: { defaultProps: { size: "md", radius: "sm" } },
    PasswordInput: { defaultProps: { size: "md", radius: "sm" } },
    Select: {
      defaultProps: { size: "sm", radius: "sm", allowDeselect: false },
      styles: { input: { minHeight: 40 } },
    },
    NumberInput: {
      defaultProps: { hideControls: true, size: "sm", radius: "sm" },
    },
    Badge: {
      defaultProps: { variant: "light", radius: "sm", tt: "none", fw: 500 },
    },
    Modal: {
      defaultProps: {
        closeButtonProps: { "aria-label": "Close dialog" },
        radius: "lg",
        centered: true,
        overlayProps: { backgroundOpacity: 0.35, blur: 3 },
        transitionProps: { duration: 170 },
      },
    },
    Drawer: {
      defaultProps: {
        closeButtonProps: { "aria-label": "Close panel" },
        position: "right",
        size: 500,
        padding: "lg",
        overlayProps: { backgroundOpacity: 0.3, blur: 2 },
        transitionProps: {
          duration: 220,
          timingFunction: "cubic-bezier(.22,1,.36,1)",
        },
      },
    },
    Tooltip: {
      defaultProps: {
        withArrow: true,
        openDelay: 350,
        multiline: true,
        maw: 280,
      },
    },
    Table: {
      defaultProps: {
        verticalSpacing: "md",
        horizontalSpacing: "md",
        highlightOnHover: true,
      },
    },
    Paper: { defaultProps: { radius: "lg", withBorder: true } },
  },
});
export const chartColours = {
  accent: "#d97706",
  axis: "#536176",
  border: "#dbe4ef",
  brand: "#1768e5",
  brandDark: "#113f8f",
  canvas: "#ffffff",
  grid: "#e5e9ef",
  heatmapHigh: "#b8dfc3",
  heatmapLow: "#f4b7b2",
  heatmapMid: "#eef2f7",
  heatmapText: "#253041",
  negative: "#b4473a",
  positive: "#2f7a49",
  secondary: "#347985",
  text: "#17191c",
  tooltip: "#ffffff",
  tooltipBorder: "#d8dadd",
  tooltipMuted: "#61656c",
  tooltipShadow: "rgba(17,24,39,.12)",
  tooltipText: "#17191c",
  warning: "#80530c",
} as const;
