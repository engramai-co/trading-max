import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tradingMaxTheme } from "@/ui/theme";

const webRoot = resolve(__dirname, "..");
const themeCssPath = resolve(webRoot, "app/shadcn-theme.css");

const CONVERTED_SPACING_SITES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["app/error.tsx", ["gap-mx-md"]],
  ["workspace/foundation.tsx", ["gap-mx-md"]],
  ["workspace/health.tsx", ["gap-mx-xs", "gap-mx-sm", "gap-mx-md", "gap-mx-lg"]],
  ["workspace/holdings.tsx", ["gap-mx-sm"]],
  ["workspace/local-onboarding.tsx", ["gap-mx-md", "gap-mx-lg", "gap-mx-xl", "mb-mx-sm", "mt-mx-sm"]],
  ["workspace/look-through.tsx", ["gap-mx-sm", "gap-mx-md", "gap-mx-lg", "mb-mx-md", "mt-mx-lg"]],
  ["workspace/narrative.tsx", ["gap-mx-md"]],
  ["workspace/research-analyst.tsx", ["gap-mx-xs"]],
  ["workspace/research-company.tsx", ["gap-mx-md", "mb-mx-lg"]],
  ["workspace/research-evidence.tsx", ["gap-mx-xs"]],
  ["workspace/research-financials.tsx", ["gap-mx-xs"]],
  ["workspace/research-notebook.tsx", ["gap-mx-xs", "gap-mx-md"]],
  ["workspace/research-options.tsx", ["gap-mx-sm", "gap-mx-md", "mt-mx-lg"]],
  ["workspace/research-price.tsx", ["gap-mx-xs", "gap-mx-sm"]],
  ["workspace/research-seasonality.tsx", ["gap-mx-xs", "gap-mx-md", "mb-mx-md"]],
  ["workspace/research-valuation-workbench.tsx", ["gap-mx-xs", "gap-mx-md", "mt-mx-md"]],
  ["workspace/research.tsx", ["gap-mx-md"]],
  ["workspace/review-perspectives.tsx", ["gap-mx-md", "gap-mx-lg"]],
  ["workspace/settings-assistant.tsx", ["gap-mx-md", "mt-mx-md"]],
  ["workspace/settings-index-data.tsx", ["gap-mx-xs", "gap-mx-md"]],
  ["workspace/settings-market-data.tsx", ["gap-mx-md"]],
  ["workspace/settings-oauth.tsx", ["gap-mx-md", "gap-mx-lg"]],
  ["workspace/settings-preferences.tsx", ["gap-mx-md", "gap-mx-lg"]],
  ["workspace/settings.tsx", ["gap-mx-md", "gap-mx-lg"]],
];

function parseThemeSpacingTokens(css: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /--spacing-mx-(xs|sm|md|lg|xl)\s*:\s*([^;]+)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    result[match[1]] = match[2].trim();
  }
  return result;
}

describe("Mantine pixel spacing parity", () => {
  it("defines pixel spacing tokens in app/shadcn-theme.css matching ui/theme.ts", () => {
    const css = readFileSync(themeCssPath, "utf8");
    const tokens = parseThemeSpacingTokens(css);

    expect(tokens).toEqual({
      xs: "6px",
      sm: "10px",
      md: "16px",
      lg: "24px",
      xl: "32px",
    });
    expect(tradingMaxTheme.spacing).toEqual(tokens);
    for (const value of Object.values(tokens)) {
      expect(value).toMatch(/^\d+px$/);
    }
  });

  it("keeps pixel mx spacing utilities at the converted call sites", () => {
    for (const [file, classes] of CONVERTED_SPACING_SITES) {
      const source = readFileSync(resolve(webRoot, file), "utf8");
      for (const cls of classes) {
        expect(source, `${file} should keep ${cls}`).toContain(cls);
      }
    }
  });
});
