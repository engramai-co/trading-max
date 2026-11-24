export type ColorScheme = "light" | "dark" | "auto";
export type ResolvedColorScheme = "light" | "dark";

export const COLOR_SCHEME_STORAGE_KEY = "mantine-color-scheme-value";
export const COLOR_SCHEME_ATTRIBUTE = "data-mantine-color-scheme";
export const DEFAULT_COLOR_SCHEME: ColorScheme = "auto";

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark" || value === "auto";
}

export const colorSchemeHtmlProps = {
  suppressHydrationWarning: true,
  [COLOR_SCHEME_ATTRIBUTE]: "light",
} as const;

export function colorSchemeInitScript(
  defaultColorScheme: ColorScheme = DEFAULT_COLOR_SCHEME,
  storageKey: string = COLOR_SCHEME_STORAGE_KEY,
): string {
  const fallback = isColorScheme(defaultColorScheme) ? defaultColorScheme : DEFAULT_COLOR_SCHEME;
  return `try {
  var _v = null;
  try {
    _v = window.localStorage.getItem(${JSON.stringify(storageKey)});
  } catch (e) {}
  var _s = _v === "light" || _v === "dark" || _v === "auto" ? _v : ${JSON.stringify(fallback)};
  var _d = false;
  try {
    _d = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {}
  var _c = _s !== "auto" ? _s : _d ? "dark" : "light";
  document.documentElement.setAttribute(${JSON.stringify(COLOR_SCHEME_ATTRIBUTE)}, _c);
} catch (e) {}`;
}
