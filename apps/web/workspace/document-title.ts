"use client";

import { useEffect } from "react";

export const PRODUCT_NAME = "Trading Max";

/** {Detail} · {Page} · Trading Max: the name of what is open, then where it lives. */
export function documentTitle(...parts: Array<string | null | undefined>) {
  return [...parts.filter((part): part is string => Boolean(part && part.trim())), PRODUCT_NAME].join(" · ");
}

/**
 * Pages are named in the reader's language, which only the client knows. Route
 * metadata can stream into the head after hydration, so the title is restored
 * whenever the head changes.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    apply();
    return () => observer.disconnect();
  }, [title]);
}
