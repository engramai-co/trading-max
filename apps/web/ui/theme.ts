import { createTheme } from "@mantine/core";

// Mantine emits its scheme variables outside the stylesheet layers. Use the
// resolver so its buttons, portals and inputs inherit the same palette.
export function resolveMantineColours() {
  const scheme = {
    "--mantine-color-body": "var(--card)",
    "--mantine-color-text": "var(--foreground)",
    "--mantine-color-bright": "var(--foreground)",
    "--mantine-color-dimmed": "var(--muted-foreground)",
    "--mantine-color-placeholder": "var(--placeholder)",
    "--mantine-color-anchor": "var(--link)",
    "--mantine-color-error": "var(--warning)",
    "--mantine-color-success": "var(--foreground)",
    "--mantine-color-default": "var(--secondary)",
    "--mantine-color-default-hover": "var(--secondary-hover)",
    "--mantine-color-default-color": "var(--secondary-foreground)",
    "--mantine-color-default-border": "var(--border)",
    "--mantine-primary-color-contrast": "var(--primary-foreground)",
    "--mantine-color-brand-filled": "var(--primary)",
    "--mantine-color-brand-filled-hover": "var(--primary-hover)",
    "--mantine-color-brand-light": "var(--muted)",
    "--mantine-color-brand-light-hover": "var(--accent)",
    "--mantine-color-brand-light-color": "var(--link)",
    "--mantine-color-brand-outline": "var(--link)",
    "--mantine-color-brand-outline-hover": "var(--accent)",
    "--mantine-color-red-outline": "var(--destructive)",
    "--mantine-color-red-outline-hover": "var(--destructive-hover)",
  };
  return {
    variables: { "--mantine-primary-color-light-color": "var(--link)" },
    light: scheme,
    dark: scheme,
  };
}

export const brandColours = [
  "#f4f4f5",
  "#dae7fb",
  "#a8caff",
  "#7eb3ff",
  "#4a8ef5",
  "#2d7cef",
  "#1e6ee6",
  "#1768e5",
  "#155fd2",
  "#124fb0",
] as const;

export const neutralGrayScale = [
  "#fafafa",
  "#f4f4f5",
  "#ececee",
  "#e4e4e7",
  "#d4d4d8",
  "#8b8b93",
  "#6b6b73",
  "#66666e",
  "#3f3f46",
  "#18181b",
] as const;

export const neutralDarkScale = [
  "#f4f4f5",
  "#d4d4d8",
  "#a1a1aa",
  "#8b8b93",
  "#3f3f46",
  "#27272a",
  "#1c1c1f",
  "#121214",
  "#09090b",
  "#09090b",
] as const;

export const destructiveScale = [
  "#f9f0ef",
  "#f5e5e3",
  "#f0cfc9",
  "#ffbdb4",
  "#ff958a",
  "#e56a5d",
  "#b4473a",
  "#b4473a",
  "#8d3026",
  "#2a1f20",
] as const;

export const darkCanvas = "#09090b";
export const lightCanvas = "#fafafa";

// Canvas text cannot inherit CSS fonts, so charts receive the same stack explicitly.
export const FONT_STACK =
  '"Avenir Next", Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';
export const tradingMaxTheme = createTheme({
  primaryColor: "brand",
  autoContrast: true,
  primaryShade: { light: 7, dark: 7 },
  colors: {
    brand: [...brandColours],
    gray: [...neutralGrayScale],
    dark: [...neutralDarkScale],
    red: [...destructiveScale],
  },
  black: "#18181b",
  white: "#ffffff",
  defaultRadius: "md",
  cursorType: "pointer",
  respectReducedMotion: true,
  fontFamily: FONT_STACK,
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
    TextInput: { defaultProps: { size: "md", radius: "sm" } },
    PasswordInput: { defaultProps: { size: "md", radius: "sm" } },
    Select: {
      defaultProps: { size: "sm", radius: "sm", allowDeselect: false },
      styles: { input: { minHeight: 40 } },
    },
    NumberInput: {
      defaultProps: { hideControls: true, size: "sm", radius: "sm" },
    },
  },
});
