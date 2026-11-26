import { darkCanvas, lightCanvas } from "@/ui/theme";

export type ColorScheme = "light" | "dark" | "auto";
export type ResolvedColorScheme = "light" | "dark";

export const COLOR_SCHEME_STORAGE_KEY = "mantine-color-scheme-value";
export const COLOR_SCHEME_ATTRIBUTE = "data-mantine-color-scheme";
export const DEFAULT_COLOR_SCHEME: ColorScheme = "dark";
const DESKTOP_PATH = /^\/desktop(?:\/|$)/;

export function isDesktopAppearancePath(pathname: string): boolean {
  return DESKTOP_PATH.test(pathname);
}

export function preferenceForPath(preference: ColorScheme, pathname: string): ColorScheme {
  return isDesktopAppearancePath(pathname) ? "auto" : preference;
}

export const THEME_COLOR_BY_SCHEME: Record<ResolvedColorScheme, string> = {
  dark: darkCanvas,
  light: lightCanvas,
};

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark" || value === "auto";
}

export const colorSchemeHtmlProps = {
  suppressHydrationWarning: true,
  [COLOR_SCHEME_ATTRIBUTE]: "dark",
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
  if (${DESKTOP_PATH}.test(window.location?.pathname ?? "")) _s = "auto";
  var _d = false;
  try {
    _d = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {}
  var _c = _s !== "auto" ? _s : _d ? "dark" : "light";
  document.documentElement.setAttribute(${JSON.stringify(COLOR_SCHEME_ATTRIBUTE)}, _c);
  function setHint(name, content) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", name);
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", content);
  }
  setHint("color-scheme", _c);
  setHint("theme-color", _c === "dark" ? ${JSON.stringify(THEME_COLOR_BY_SCHEME.dark)} : ${JSON.stringify(THEME_COLOR_BY_SCHEME.light)});
} catch (e) {}`;
}
