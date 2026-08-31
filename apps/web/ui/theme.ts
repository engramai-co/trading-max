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
  autoContrast: true,
  black: "#111827",
  colors: {
    brand: [...brandColours],
  },
  components: {
    ActionIcon: {
      defaultProps: {
        radius: "md",
        size: 44,
        variant: "subtle",
      },
    },
    Accordion: {
      styles: {
        control: {
          minHeight: 48,
        },
        item: {
          overflow: "hidden",
        },
      },
    },
    Badge: {
      defaultProps: {
        radius: "sm",
        variant: "light",
      },
    },
    Button: {
      defaultProps: {
        radius: "md",
      },
      styles: {
        root: {
          minHeight: 44,
        },
      },
    },
    Card: {
      defaultProps: {
        padding: "lg",
        radius: "lg",
        withBorder: true,
      },
    },
    Drawer: {
      defaultProps: {
        transitionProps: {
          duration: 240,
          exitDuration: 180,
          timingFunction: "cubic-bezier(0.32, 0.72, 0, 1)",
        },
      },
    },
    Input: {
      defaultProps: {
        radius: "md",
        size: "md",
      },
    },
    Modal: {
      defaultProps: {
        centered: true,
        radius: "lg",
      },
    },
    NavLink: {
      defaultProps: {
        color: "brand",
      },
      styles: {
        label: {
          fontWeight: 600,
        },
        root: {
          borderRadius: "var(--mantine-radius-md)",
          minHeight: 44,
          transition:
            "background-color 160ms cubic-bezier(0.23, 1, 0.32, 1), color 160ms cubic-bezier(0.23, 1, 0.32, 1)",
        },
      },
    },
    Paper: {
      defaultProps: {
        radius: "lg",
      },
    },
    Tabs: {
      defaultProps: {
        keepMounted: false,
        variant: "default",
      },
    },
    TextInput: {
      defaultProps: {
        radius: "md",
        size: "md",
      },
    },
  },
  cursorType: "pointer",
  defaultGradient: {
    deg: 135,
    from: "brand.7",
    to: "cyan.5",
  },
  defaultRadius: "md",
  fontFamily:
    'Inter, "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace:
    '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily:
      'Inter, "SF Pro Display", "PingFang SC", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: "700",
    sizes: {
      h1: { fontSize: "clamp(2rem, 4vw, 3.25rem)", lineHeight: "1.08" },
      h2: { fontSize: "clamp(1.35rem, 2.4vw, 2rem)", lineHeight: "1.2" },
      h3: { fontSize: "1.125rem", lineHeight: "1.3" },
    },
  },
  luminanceThreshold: 0.34,
  primaryColor: "brand",
  primaryShade: {
    dark: 5,
    light: 7,
  },
  respectReducedMotion: true,
  shadows: {
    lg: "0 18px 48px rgba(17, 24, 39, 0.10)",
    md: "0 10px 28px rgba(17, 24, 39, 0.07)",
    sm: "0 4px 14px rgba(17, 24, 39, 0.05)",
    xl: "0 28px 64px rgba(17, 24, 39, 0.14)",
    xs: "0 1px 4px rgba(17, 24, 39, 0.04)",
  },
  spacing: {
    lg: "1.25rem",
    md: "0.875rem",
    sm: "0.625rem",
    xl: "1.75rem",
    xs: "0.375rem",
    xxl: "2.5rem",
  },
  white: "#ffffff",
});

export const chartColours = {
  accent: "#d97706",
  axis: "#6b7280",
  border: "#dbe1e8",
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
  tooltip: "#111827",
  warning: "#96630e",
} as const;
