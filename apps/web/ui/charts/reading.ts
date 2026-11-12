"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

export const ReadingBoundary = createContext<((token: symbol, active: boolean) => void) | null>(null);

/** A portfolio can hold a complete snapshot while a chart or its records are being read. */
export function useReadingBoundary() {
  const readers = useRef(new Set<symbol>());
  const [active, setActive] = useState(false);
  const report = useCallback((token: symbol, reading: boolean) => {
    if (reading) readers.current.add(token);
    else readers.current.delete(token);
    setActive(readers.current.size > 0);
  }, []);
  return { active, report };
}

export function useReadingLock(active: boolean) {
  const report = useContext(ReadingBoundary);
  const [token] = useState(() => Symbol());
  useLayoutEffect(() => {
    if (!active || !report) return;
    report(token, true);
    return () => report(token, false);
  }, [active, report, token]);
}
