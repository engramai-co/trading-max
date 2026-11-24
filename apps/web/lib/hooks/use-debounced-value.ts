"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useDebouncedValue<T>(
  value: T,
  wait: number,
  options: { leading?: boolean } = {},
): readonly [T, () => void] {
  const leading = options.leading ?? false;
  const [debounced, setDebounced] = useState<T>(value);
  const mountedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownRef = useRef(false);

  const cancel = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    cooldownRef.current = false;
  }, []);

  useEffect(() => {
    if (!mountedRef.current) return;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!cooldownRef.current && leading) {
      cooldownRef.current = true;
      setDebounced(value);
      timeoutRef.current = setTimeout(() => {
        cooldownRef.current = false;
        timeoutRef.current = null;
      }, wait);
    } else {
      timeoutRef.current = setTimeout(() => {
        cooldownRef.current = false;
        timeoutRef.current = null;
        setDebounced(value);
      }, wait);
    }
  }, [value, wait, leading]);

  useEffect(() => {
    mountedRef.current = true;
    return cancel;
  }, [cancel]);

  return [debounced, cancel] as const;
}
