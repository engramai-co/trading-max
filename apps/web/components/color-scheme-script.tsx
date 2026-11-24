import {
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  colorSchemeInitScript,
  type ColorScheme,
} from "@/lib/color-scheme";

export function ColorSchemeScript({
  defaultColorScheme = DEFAULT_COLOR_SCHEME,
  storageKey = COLOR_SCHEME_STORAGE_KEY,
}: Readonly<{
  defaultColorScheme?: ColorScheme;
  storageKey?: string;
}>) {
  return (
    <script
      data-color-scheme-script=""
      dangerouslySetInnerHTML={{
        __html: colorSchemeInitScript(defaultColorScheme, storageKey),
      }}
    />
  );
}
