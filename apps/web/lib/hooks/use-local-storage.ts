"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

export type UseLocalStorageOptions<T> = {
  key: string;
  defaultValue: T;
  serialize?: (value: T) => string;
  deserialize?: (value: string) => T;
};

type SetStorageValue<T> = (value: T | ((previous: T) => T)) => void;

const listenersByKey = new Map<string, Set<() => void>>();
const memoryFallback = new Map<string, string | null>();
let storageListenerAttached = false;

function serializeJSON<T>(value: T): string {
  return JSON.stringify(value);
}

function deserializeJSON<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function notifyKey(key: string) {
  const listeners = listenersByKey.get(key);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function handleWindowStorage(event: StorageEvent) {
  if (typeof window === "undefined") return;
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (event.key === null) {
    memoryFallback.clear();
    for (const key of listenersByKey.keys()) notifyKey(key);
    return;
  }
  memoryFallback.delete(event.key);
  notifyKey(event.key);
}

function ensureStorageListener() {
  if (typeof window === "undefined" || storageListenerAttached) return;
  storageListenerAttached = true;
  window.addEventListener("storage", handleWindowStorage);
}

function readRawItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRawItem(key: string, serialized: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, serialized);
    memoryFallback.delete(key);
  } catch {
    memoryFallback.set(key, serialized);
  }
}

function removeRawItem(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
    memoryFallback.delete(key);
  } catch {
    memoryFallback.set(key, null);
  }
}

const getServerRawSnapshot = () => null;
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function useLocalStorage<T>({
  key,
  defaultValue,
  serialize = serializeJSON,
  deserialize = deserializeJSON,
}: UseLocalStorageOptions<T>): readonly [T, SetStorageValue<T>, () => void] {
  const optionsRef = useRef({ defaultValue, serialize, deserialize });
  useIsomorphicLayoutEffect(() => {
    optionsRef.current = { defaultValue, serialize, deserialize };
  }, [defaultValue, serialize, deserialize]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      ensureStorageListener();
      let listeners = listenersByKey.get(key);
      if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
      }
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) listenersByKey.delete(key);
      };
    },
    [key],
  );

  const getRawSnapshot = useCallback(() => readRawItem(key), [key]);

  const raw = useSyncExternalStore(subscribe, getRawSnapshot, getServerRawSnapshot);

  const value = useMemo<T>(() => {
    if (raw === null) return defaultValue;
    return deserialize(raw);
  }, [raw, defaultValue, deserialize]);

  const setValue = useCallback<SetStorageValue<T>>(
    (next) => {
      const {
        defaultValue: fallback,
        serialize: toString,
        deserialize: fromString,
      } = optionsRef.current;
      const currentRaw = readRawItem(key);
      const current = currentRaw !== null ? fromString(currentRaw) : fallback;
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      writeRawItem(key, toString(resolved));
      notifyKey(key);
    },
    [key],
  );

  const removeValue = useCallback(() => {
    removeRawItem(key);
    notifyKey(key);
  }, [key]);

  return [value, setValue, removeValue] as const;
}

export function resetLocalStorageStoreForTests() {
  memoryFallback.clear();
  listenersByKey.clear();
  if (storageListenerAttached && typeof window !== "undefined") {
    window.removeEventListener("storage", handleWindowStorage);
    storageListenerAttached = false;
  }
}
