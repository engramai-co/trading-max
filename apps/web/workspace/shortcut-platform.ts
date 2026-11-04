"use client";

import { useSyncExternalStore } from "react";

/**
 * The modifier that picks an option with a digit, or null where the browser or system
 * already owns it: Firefox on Linux selects tabs with Alt+1–8 and ChromeOS opens shelf
 * apps with it, so Linux, Android and ChromeOS bind nothing, nor does an unknown
 * platform. Apple devices use ⌥; Windows, Firefox included, uses Alt.
 */
export function altDigitModifier(userAgent: string): "⌥" | "Alt" | null {
  if (/CrOS|Android|Linux/i.test(userAgent)) return null;
  if (/Macintosh|MacIntel|MacPPC|Mac68K|iPhone|iPad|iPod/i.test(userAgent)) return "⌥";
  if (/Windows|Win32|Win64|WinCE/i.test(userAgent)) return "Alt";
  return null;
}

const unchanging = () => () => {};

/** Null on the server and until the browser is known, so no key is bound or announced early. */
export function useAltDigitModifier() {
  return useSyncExternalStore(unchanging, () => altDigitModifier(navigator.userAgent), () => null);
}
