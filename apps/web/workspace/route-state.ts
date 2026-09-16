"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
export function useRouteState() {
  const params = useSearchParams();
  const pathname = usePathname();
  const update = useCallback((values: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const suffix = next.toString();
    window.history.replaceState(
      null,
      "",
      pathname + (suffix ? "?" + suffix : ""),
    );
  }, [pathname]);
  return { params, update };
}
