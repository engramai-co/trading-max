import {
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  colorSchemeInitScript,
  type ColorScheme,
} from "@/lib/color-scheme";
import { overviewLayoutInitScript } from "@/lib/overview-layout-storage";

export function ColorSchemeScript({
  defaultColorScheme = DEFAULT_COLOR_SCHEME,
  storageKey = COLOR_SCHEME_STORAGE_KEY,
  overviewScope,
}: Readonly<{
  defaultColorScheme?: ColorScheme;
  storageKey?: string;
  overviewScope?: string;
}>) {
  const scheme = colorSchemeInitScript(defaultColorScheme, storageKey);
  const overview = overviewScope ? overviewLayoutInitScript(overviewScope) : "";
  return (
    <script
      data-color-scheme-script=""
      dangerouslySetInnerHTML={{
        __html: scheme + "\n" + overview,
      }}
    />
  );
}
