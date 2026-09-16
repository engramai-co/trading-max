"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
export function useRouteState(history: "replace" | "push" = "replace") {
  const params = useSearchParams();
  const pathname = usePathname();
  const update = useCallback(
    (values: Record<string, string | null>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const suffix = next.toString();
      const url = pathname + (suffix ? "?" + suffix : "");
      if (url === window.location.pathname + window.location.search) return;
      window.history[history === "push" ? "pushState" : "replaceState"](
        null,
        "",
        url,
      );
    },
    [pathname, history],
  );
  return { params, update };
}
