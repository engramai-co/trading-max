import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BREAKPOINTS, MEDIA_QUERIES } from "./breakpoints";

const themeCssPath = resolve(__dirname, "../app/shadcn-theme.css");

function parseLengthDeclarations(css: string, unit: "px" | "em"): Record<string, number> {
  const result: Record<string, number> = {};
  const pattern = new RegExp(`(--[a-z0-9-]+)\\s*:\\s*(\\d+)${unit}\\s*;`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    result[match[1]] = Number(match[2]);
  }
  return result;
}

describe("breakpoints single source of truth", () => {
  it("matches every @theme breakpoint and :root threshold in app/shadcn-theme.css", () => {
    const css = readFileSync(themeCssPath, "utf8");
    const pxVars = parseLengthDeclarations(css, "px");
    const emVars = parseLengthDeclarations(css, "em");

    expect(pxVars["--breakpoint-narrow"]).toBe(BREAKPOINTS.narrowMax);
    expect(pxVars["--breakpoint-phone"]).toBe(BREAKPOINTS.phoneMax + 1);
    expect(pxVars["--breakpoint-tablet"]).toBe(BREAKPOINTS.tabletMax + 1);
    expect(pxVars["--breakpoint-wide-map"]).toBe(BREAKPOINTS.wideMapMin);
    expect(pxVars["--breakpoint-desktop"]).toBe(BREAKPOINTS.desktopMax + 1);
    expect(pxVars["--breakpoint-wide"]).toBe(BREAKPOINTS.wideMin);

    expect(pxVars["--mx-bp-narrow-max"]).toBe(BREAKPOINTS.narrowMax);
    expect(pxVars["--mx-bp-phone-max"]).toBe(BREAKPOINTS.phoneMax);
    expect(pxVars["--mx-bp-tablet-max"]).toBe(BREAKPOINTS.tabletMax);
    expect(pxVars["--mx-bp-phone-landscape-max-height"]).toBe(BREAKPOINTS.phoneLandscapeMaxHeight);
    expect(pxVars["--mx-bp-wide-map-min"]).toBe(BREAKPOINTS.wideMapMin);
    expect(pxVars["--mx-bp-desktop-max"]).toBe(BREAKPOINTS.desktopMax);
    expect(pxVars["--mx-bp-wide-min"]).toBe(BREAKPOINTS.wideMin);
    expect(emVars["--mx-bp-research-index-max"]).toBe(BREAKPOINTS.researchIndexMaxEm);
  });

  it("derives named media queries from the consolidated pixel and em thresholds", () => {
    expect(MEDIA_QUERIES.narrow).toBe("(max-width: 375px)");
    expect(MEDIA_QUERIES.phone).toBe("(max-width: 767px)");
    expect(MEDIA_QUERIES.researchIndexPhone).toBe("(max-width: 48em)");
    expect(MEDIA_QUERIES.desktop).toBe("(min-width: 768px)");
    expect(MEDIA_QUERIES.phoneDock).toBe(
      "(max-width: 767px), (max-width: 959px) and (max-height: 500px) and (pointer: coarse)",
    );
    expect(MEDIA_QUERIES.shortLandscapeDock).toBe(
      "(max-width: 959px) and (max-height: 500px) and (orientation: landscape) and (pointer: coarse)",
    );
    expect(MEDIA_QUERIES.touchLayout).toBe(
      "(max-width: 767px), (hover: none) and (pointer: coarse)",
    );
    expect(MEDIA_QUERIES.wideMap).toBe("(min-width: 1180px)");
    expect(MEDIA_QUERIES.compactDesktop).toBe("(max-width: 1199px)");
    expect(MEDIA_QUERIES.wide).toBe("(min-width: 1280px)");
  });

  it("stays aligned with the matching shell, assistant, global-markets, and research-index CSS media queries", () => {
    const shellCss = readFileSync(resolve(__dirname, "../app/styles/23-workspace-shell.css"), "utf8");
    const assistantCss = readFileSync(resolve(__dirname, "../app/styles/19-assistant.css"), "utf8");
    const globalMarketsCss = readFileSync(resolve(__dirname, "../app/styles/13a1-global-markets.css"), "utf8");
    const researchIndexCss = readFileSync(resolve(__dirname, "../app/styles/13b-research-index.css"), "utf8");
    const researchIndexChartTsx = readFileSync(resolve(__dirname, "../workspace/research-index-chart.tsx"), "utf8");

    expect(shellCss).toContain(`@media ${MEDIA_QUERIES.phoneDock}`);
    expect(shellCss).toContain(`@media ${MEDIA_QUERIES.shortLandscapeDock}`);
    expect(shellCss).toContain(`@media ${MEDIA_QUERIES.compactDesktop}`);
    expect(shellCss).toContain(`@media ${MEDIA_QUERIES.phone}`);
    expect(assistantCss).toContain(`@media ${MEDIA_QUERIES.phoneDock}`);
    expect(assistantCss).toContain(`@media ${MEDIA_QUERIES.compactDesktop}`);
    expect(globalMarketsCss).toContain(`(max-width: ${BREAKPOINTS.wideMapMin - 1}px)`);
    expect(researchIndexCss).toContain(`@media ${MEDIA_QUERIES.researchIndexPhone}`);
    expect(researchIndexChartTsx).toContain('useBreakpoint("researchIndexPhone")');
  });
});
