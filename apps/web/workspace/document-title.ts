"use client";

import { useEffect } from "react";

export const PRODUCT_NAME = "Trading Max";

/** {Detail} · {Page} · Trading Max: the name of what is open, then where it lives. */
export function documentTitle(...parts: Array<string | null | undefined>) {
  return [...parts.filter((part): part is string => Boolean(part && part.trim())), PRODUCT_NAME].join(" · ");
}

const pageTitles = new Map<symbol, string>();
const statusTitles = new Map<symbol, string>();
let observer: MutationObserver | undefined;

function applyDocumentTitle() {
  const title = [...statusTitles.values()].at(-1) ?? [...pageTitles.values()].at(-1);
  if (title && document.title !== title) document.title = title;
}

/**
 * Pages are named in the reader's language, which only the client knows. Route
 * metadata can stream into the head after hydration, so the title is restored
 * whenever the head changes. A mounted route fallback takes priority over the
 * shell, which stays mounted while error and not-found content is shown.
 */
export function useDocumentTitle(title: string, kind: "page" | "status" = "page") {
  useEffect(() => {
    const key = Symbol();
    const titles = kind === "status" ? statusTitles : pageTitles;
    titles.set(key, title);
    if (!observer) {
      observer = new MutationObserver(applyDocumentTitle);
      observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    }
    applyDocumentTitle();
    return () => {
      titles.delete(key);
      if (pageTitles.size || statusTitles.size) {
        applyDocumentTitle();
      } else {
        observer?.disconnect();
        observer = undefined;
      }
    };
  }, [title, kind]);
}
