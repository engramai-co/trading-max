import { describe, expect, it } from "vitest";
import { readAllocationChartColours } from "@/ui/charts/palette";
import { toCanvasColour } from "@/ui/charts/canvas-colour";
import { darkCanvas, lightCanvas } from "@/ui/theme";
import { ALLOCATION_SLICE_OPACITY } from "@/workspace/allocation-composition";
import { chartColours, darkChartColours, parseBlock, resolveToken, themeCss, tokensByScheme } from "../tests/fixtures/theme-colours";

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) {
    throw new Error(`Expected 6-digit hex colour, received "${hex}"`);
  }
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const c = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return c * 255;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function mixSrgb(a: Rgb, b: Rgb, weightA: number): Rgb {
  return [
    a[0] * weightA + b[0] * (1 - weightA),
    a[1] * weightA + b[1] * (1 - weightA),
    a[2] * weightA + b[2] * (1 - weightA),
  ];
}

function rgbToOklab([r, g, b]: Rgb): readonly [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: readonly [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function mixOklab(a: Rgb, b: Rgb, weightA: number): Rgb {
  const oa = rgbToOklab(a);
  const ob = rgbToOklab(b);
  return oklabToRgb([
    oa[0] * weightA + ob[0] * (1 - weightA),
    oa[1] * weightA + ob[1] * (1 - weightA),
    oa[2] * weightA + ob[2] * (1 - weightA),
  ]);
}

describe("Palette A neutral-ink colour tokens and WCAG contrast contract", () => {
  it("defines all colour tokens as plain hex (no light-dark()) and exposes them to Tailwind", () => {
    expect(themeCss).not.toContain("light-dark(");
    const themeInline = parseBlock(themeCss, /@theme inline\s*\{/);
    for (const key of [
      "--color-background",
      "--color-foreground",
      "--color-card",
      "--color-popover",
      "--color-primary",
      "--color-secondary",
      "--color-muted",
      "--color-muted-foreground",
      "--color-accent",
      "--color-destructive",
      "--color-border",
      "--color-input",
      "--color-ring",
      "--color-chart-1",
      "--color-chart-5",
      "--color-sidebar",
      "--color-sidebar-accent",
    ]) {
      expect(themeInline[key], `Missing @theme inline mapping ${key}`).toBeDefined();
    }
  });

  for (const scheme of ["dark", "light"] as const) {
    const tokens = tokensByScheme[scheme];
    const hex = (name: string) => parseHex(resolveToken(tokens, name));

    it(`meets ≥ 4.5:1 WCAG AA contrast for every text foreground/background token pair (${scheme})`, () => {
      const textPairs: Array<[string, string, number]> = [
        ["--foreground", "--background", 4.5],
        ["--card-foreground", "--card", 4.5],
        ["--popover-foreground", "--popover", 4.5],
        ["--primary-foreground", "--primary", 4.5],
        ["--primary-foreground", "--primary-hover", 4.5],
        ["--primary-foreground", "--primary-active", 4.5],
        ["--secondary-foreground", "--secondary", 4.5],
        ["--secondary-foreground", "--secondary-hover", 4.5],
        ["--secondary-foreground", "--secondary-active", 4.5],
        ["--foreground", "--muted", 4.5],
        ["--muted-foreground", "--background", 4.5],
        ["--muted-foreground", "--card", 4.5],
        ["--muted-foreground", "--muted", 4.5],
        ["--muted-foreground", "--popover", 4.5],
        ["--accent-foreground", "--accent", 4.5],
        ["--foreground", "--ghost-hover", 4.5],
        ["--foreground", "--ghost-active", 4.5],
        ["--foreground", "--segment-indicator", 4.5],
        ["--sidebar-foreground", "--sidebar", 4.5],
        ["--sidebar-foreground", "--accent", 4.5],
        ["--sidebar-accent-foreground", "--sidebar-accent", 4.5],
        ["--sidebar-primary-foreground", "--sidebar-primary", 4.5],
        ["--destructive", "--background", 4.5],
        ["--destructive", "--card", 4.5],
        ["--destructive", "--popover", 4.5],
        ["--destructive", "--destructive-hover", 4.5],
        ["--destructive-active-ink", "--destructive-active", 4.5],
        ["--gain", "--background", 4.5],
        ["--gain", "--card", 4.5],
        ["--gain", "--muted", 4.5],
        ["--loss", "--background", 4.5],
        ["--loss", "--card", 4.5],
        ["--loss", "--muted", 4.5],
        ["--warning", "--background", 4.5],
        ["--warning", "--card", 4.5],
        ["--warning", "--muted", 4.5],
        ["--link", "--background", 4.5],
        ["--link", "--card", 4.5],
        ["--link", "--muted", 4.5],
        ["--link", "--popover", 4.5],
        ["--foreground", "--field", 4.5],
        ["--placeholder", "--field", 4.5],
        ["--key-moment-ink", "--key-moment-bg", 4.5],
      ];

      // Selected results and selectable text can contain links, muted labels,
      // financial figures and data warnings in addition to ordinary ink.
      for (const ink of ["--foreground", "--muted-foreground", "--link", "--gain", "--loss", "--warning", "--destructive"]) {
        textPairs.push([ink, "--selection", 4.5]);
      }

      for (const [fg, bg, min] of textPairs) {
        const ratio = contrastRatio(hex(fg), hex(bg));
        expect(ratio, `${scheme} ${fg} on ${bg} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(min);
      }
    });

    it(`meets muted text targets (${scheme})`, () => {
      if (scheme === "dark") {
        const ratio = contrastRatio(hex("--muted-foreground"), hex("--card"));
        expect(ratio, `dark muted-foreground on card (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(7.3);
      } else {
        const ratio = contrastRatio(hex("--muted-foreground"), hex("--background"));
        expect(ratio, `light muted-foreground on background (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(5.45);
        const onCard = contrastRatio(hex("--muted-foreground"), hex("--card"));
        expect(onCard, `light muted-foreground on card (${onCard.toFixed(2)}:1)`).toBeGreaterThanOrEqual(5.5);
      }
    });

    it(`meets ≥ 3:1 non-text contrast for boundaries, switches, focus rings, scrollbars, and allocation palette (${scheme})`, () => {
      const uiPairs: Array<[string, string]> = [
        ["--input", "--card"],
        ["--input", "--field"],
        ["--input-hover", "--card"],
        ["--input-hover", "--field"],
        ["--switch-off", "--card"],
        ["--switch-off-hover", "--card"],
        ["--primary-foreground", "--switch-off"],
        ["--ring", "--background"],
        ["--ring", "--card"],
        ["--ring", "--popover"],
        ["--sidebar-ring", "--sidebar"],
        ["--sidebar-foreground", "--sidebar"],
        ["--sidebar-accent-foreground", "--sidebar-accent"],
        ["--scrollbar-thumb", "--background"],
        ["--scrollbar-thumb", "--card"],
        ["--scrollbar-thumb", "--muted"],
        ["--chart-1", "--card"],
        ["--chart-2", "--card"],
        ["--chart-3", "--card"],
        ["--chart-4", "--card"],
        ["--chart-5", "--card"],
      ];

      for (const [fg, bg] of uiPairs) {
        const ratio = contrastRatio(hex(fg), hex(bg));
        expect(ratio, `${scheme} ${fg} vs ${bg} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(3);
      }

      // The neutral aggregate is identified by its muted-ink edge.
      expect(contrastRatio(hex("--muted-foreground"), hex("--card"))).toBeGreaterThanOrEqual(3);
      for (let i = 1; i <= 12; i += 1) {
        const token = `--allocation-${i}`;
        const panel = hex("--card");
        const composite = mixSrgb(hex(token), panel, ALLOCATION_SLICE_OPACITY);
        const ratio = contrastRatio(composite, panel);
        expect(ratio, `${scheme} ${token} vs --card (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`keeps ≥ 4.5:1 text contrast across the full market heat wash range in sRGB and OKLab (${scheme})`, () => {
      const ink = hex("--foreground");
      const base = hex("--heat-base");
      const weights = scheme === "dark" ? [0, 0.23, 0.465, 0.7] : [0, 0.12, 0.335, 0.55];
      for (const hueToken of ["--heat-gain", "--heat-loss"] as const) {
        const hue = hex(hueToken);
        for (const weight of weights) {
          const srgbRatio = contrastRatio(ink, mixSrgb(hue, base, weight));
          const oklabRatio = contrastRatio(ink, mixOklab(hue, base, weight));
          expect(srgbRatio, `${scheme} ink on sRGB ${hueToken} ${weight}`).toBeGreaterThanOrEqual(4.5);
          expect(oklabRatio, `${scheme} ink on OKLab ${hueToken} ${weight}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const fallback of ["--heat-gain-fallback", "--heat-loss-fallback", "--heat-missing", "--heat-gain-subtle", "--heat-loss-subtle"] as const) {
        const ratio = contrastRatio(ink, hex(fallback));
        expect(ratio, `${scheme} ink on ${fallback} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5);
      }
      const card = hex("--card");
      for (const [fgToken, subtleToken] of [
        ["--gain", "--heat-gain-subtle"],
        ["--loss", "--heat-loss-subtle"],
      ] as const) {
        const hue = hex(fgToken);
        expect(contrastRatio(hue, hex(subtleToken)), `${scheme} ${fgToken} on ${subtleToken}`).toBeGreaterThanOrEqual(4.5);
        const pillInk = mixOklab(hue, ink, 0.72);
        for (const heat of [0, 0.5, 1]) {
          const pillBg = mixOklab(hue, card, 0.07 + heat * 0.17);
          const ratio = contrastRatio(pillInk, pillBg);
          expect(ratio, `${scheme} return pill ${fgToken} heat=${heat} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it("keeps TypeScript theme and ECharts palettes synced with CSS tokens", () => {
    expect(darkCanvas).toBe(tokensByScheme.dark["--background"]);
    expect(lightCanvas).toBe(tokensByScheme.light["--background"]);

    const canvasSafe = /^rgba?\(\d+, \d+, \d+(?:, (?:0|1|0?\.\d+))?\)$/;
    for (const [scheme, palette] of [
      ["light", chartColours],
      ["dark", darkChartColours],
    ] as const) {
      const tokens = tokensByScheme[scheme];
      const rgb = (name: string) => toCanvasColour(resolveToken(tokens, name));
      expect(palette.brand).toBe(rgb("--chart-1"));
      expect(palette.comparison).toBe(rgb("--chart-2"));
      expect(palette.accent).toBe(rgb("--chart-3"));
      expect(palette.secondary).toBe(rgb("--chart-4"));
      expect(palette.series5).toBe(rgb("--chart-5"));
      expect(palette.positive).toBe(rgb("--gain"));
      expect(palette.negative).toBe(rgb("--loss"));
      expect(palette.warning).toBe(rgb("--warning"));
      expect(palette.axis).toBe(rgb("--muted-foreground"));
      expect(palette.border).toBe(rgb("--border-strong"));
      expect(palette.grid).toBe(rgb("--border"));
      expect(palette.canvas).toBe(rgb("--card"));
      expect(palette.muted).toBe(rgb("--muted"));
      expect(palette.selection).toBe(rgb("--selection"));
      expect(palette.allocationRest).toBe(rgb("--allocation-rest"));
      expect(palette.text).toBe(rgb("--foreground"));
      expect(palette.tooltip).toBe(rgb("--popover"));
      expect(palette.tooltipBorder).toBe(rgb("--panel-edge"));
      expect(palette.tooltipText).toBe(rgb("--popover-foreground"));
      expect(palette.shadowPopover).toBe(tokens["--shadow-popover"]);
      expect(palette.tooltipRadius).toBe(tokens["--radius-tooltip"]);
      for (const [key, value] of Object.entries(palette)) {
        if (key === "shadowPopover" || key === "tooltipRadius") continue;
        expect(value, `${scheme} palette.${key}`).toMatch(canvasSafe);
      }

      const cssAllocation = [
        ...Array.from({ length: 12 }, (_, index) => rgb(`--allocation-${index + 1}`)),
        rgb("--allocation-rest"),
      ];
      const resolvedAllocation = readAllocationChartColours((name) => resolveToken(tokens, name));
      expect(resolvedAllocation).toEqual(cssAllocation);
      for (const colour of resolvedAllocation) {
        expect(colour).toMatch(canvasSafe);
      }
    }
  });
});
