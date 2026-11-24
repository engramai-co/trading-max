"use client";

import { useCallback, useSyncExternalStore } from "react";
import { MEDIA_QUERIES, type MediaQueryName } from "@/lib/breakpoints";

/**
 * Subscribes to a CSS media query via matchMedia + useSyncExternalStore.
 * Returns `initialValue` (default false) during SSR and initial hydration,
 * matching Mantine's SSR snapshot behavior without hydration mismatches.
 */
export function useMediaQuery(query: string, initialValue = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      try {
        const mediaQuery = window.matchMedia(query);
        mediaQuery.addEventListener("change", onStoreChange);
        return () => mediaQuery.removeEventListener("change", onStoreChange);
      } catch {
        return () => {};
      }
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return initialValue;
    }
    try {
      return window.matchMedia(query).matches;
    } catch {
      return initialValue;
    }
  }, [query, initialValue]);

  return useSyncExternalStore(subscribe, getSnapshot, () => initialValue);
}

export function useBreakpoint(name: MediaQueryName, initialValue = false): boolean {
  return useMediaQuery(MEDIA_QUERIES[name], initialValue);
}
