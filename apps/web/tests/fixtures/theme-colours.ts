import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAllocationChartColours, readChartColours } from "@/ui/charts/palette";

const themeCssPath = resolve(import.meta.dirname, "../../app/shadcn-theme.css");
export const themeCss = readFileSync(themeCssPath, "utf8");

type Scheme = "dark" | "light";

export function parseBlock(css: string, headerPattern: RegExp): Record<string, string> {
  const match = headerPattern.exec(css);
  if (!match) {
    throw new Error(`Could not find token block matching ${headerPattern}`);
  }
  const start = match.index + match[0].length;
  let depth = 1;
  let end = start;
  while (end < css.length && depth > 0) {
    const ch = css[end];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    end += 1;
  }
  const body = css.slice(start, end - 1);
  const tokens: Record<string, string> = {};
  for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[decl[1]] = decl[2].trim();
  }
  return tokens;
}

export function resolveToken(tokens: Record<string, string>, name: string): string {
  const raw = tokens[name];
  if (!raw) throw new Error(`Missing token ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(raw);
  return ref ? resolveToken(tokens, ref[1]) : raw;
}

export const tokensByScheme: Record<Scheme, Record<string, string>> = {
  dark: parseBlock(themeCss, /:root,\s*html\[data-mantine-color-scheme="dark"\]\s*\{/),
  light: parseBlock(themeCss, /html\[data-mantine-color-scheme="light"\]\s*\{/),
};

export const chartColours = readChartColours((name) => resolveToken(tokensByScheme.light, name));
export const darkChartColours = readChartColours((name) => resolveToken(tokensByScheme.dark, name));

export const allocationChartColours = {
  light: readAllocationChartColours((name) => resolveToken(tokensByScheme.light, name)),
  dark: readAllocationChartColours((name) => resolveToken(tokensByScheme.dark, name)),
};
