"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  COLOR_SCHEME_ATTRIBUTE,
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  isColorScheme,
  type ColorScheme,
  type ResolvedColorScheme,
} from "@/lib/color-scheme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

type ColorSchemeContextValue = {
  colorScheme: ColorScheme;
  resolvedColorScheme: ResolvedColorScheme;
  setColorScheme: (value: ColorScheme, options?: { keepTransitions?: boolean }) => void;
  clearColorScheme: (options?: { keepTransitions?: boolean }) => void;
  toggleColorScheme: () => void;
};

type MantineCompatibleColorSchemeManager = {
  get: (defaultValue: ColorScheme) => ColorScheme;
  set: (value: ColorScheme) => void;
  subscribe: (onUpdate: (colorScheme: ColorScheme) => void) => void;
  unsubscribe: () => void;
  clear: () => void;
};

const preferenceListeners = new Set<() => void>();
const osListeners = new Set<() => void>();
let currentPreference: ColorScheme = DEFAULT_COLOR_SCHEME;
let preferenceInitialized = false;
let storageSubscribed = false;
let osMediaQuery: MediaQueryList | null = null;
let osMediaListener: (() => void) | null = null;
let transitionTimeout: number | null = null;

function readStoredPreference(defaultValue: ColorScheme = DEFAULT_COLOR_SCHEME): ColorScheme {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    return isColorScheme(raw) ? raw : defaultValue;
  } catch {
    return defaultValue;
  }
}

function readOsColorScheme(): ResolvedColorScheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveColorScheme(
  scheme: ColorScheme,
  osScheme: ResolvedColorScheme,
): ResolvedColorScheme {
  return scheme === "auto" ? osScheme : scheme;
}

function applyColorSchemeAttribute(scheme: ColorScheme) {
  if (typeof document === "undefined") return;
  const resolved = resolveColorScheme(scheme, readOsColorScheme());
  if (document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE) !== resolved) {
    document.documentElement.setAttribute(COLOR_SCHEME_ATTRIBUTE, resolved);
  }
}

function ensurePreferenceInitialized(defaultValue: ColorScheme = DEFAULT_COLOR_SCHEME): ColorScheme {
  if (typeof window === "undefined") return defaultValue;
  if (!preferenceInitialized) {
    preferenceInitialized = true;
    currentPreference = readStoredPreference(defaultValue);
  }
  return currentPreference;
}

function notifyPreferenceListeners() {
  for (const listener of preferenceListeners) listener();
}

function notifyOsListeners() {
  for (const listener of osListeners) listener();
}

function disableTransitionsTemporarily() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (transitionTimeout !== null) {
    window.clearTimeout(transitionTimeout);
    transitionTimeout = null;
  }
  let style = document.querySelector<HTMLStyleElement>("style[data-tm-disable-transition]");
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("data-tm-disable-transition", "true");
    style.textContent = "*, *::before, *::after { transition: none !important; }";
    document.head.appendChild(style);
  }
  transitionTimeout = window.setTimeout(() => {
    transitionTimeout = null;
    document
      .querySelectorAll("style[data-tm-disable-transition]")
      .forEach((element) => element.remove());
  }, 10);
}

function handleStorageEvent(event: StorageEvent) {
  let storage: Storage;
  try {
    storage = window.localStorage;
    if (event.storageArea !== storage) return;
  } catch {
    return;
  }
  if (event.key !== null && event.key !== COLOR_SCHEME_STORAGE_KEY) return;
  let next: ColorScheme;
  try {
    const raw = storage.getItem(COLOR_SCHEME_STORAGE_KEY);
    next = isColorScheme(raw) ? raw : DEFAULT_COLOR_SCHEME;
  } catch {
    return;
  }
  if (next !== ensurePreferenceInitialized()) {
    currentPreference = next;
    applyColorSchemeAttribute(next);
    notifyPreferenceListeners();
  }
}

function ensureWindowListeners() {
  if (typeof window === "undefined") return;
  if (!storageSubscribed) {
    storageSubscribed = true;
    window.addEventListener("storage", handleStorageEvent);
  }
  if (!osMediaQuery && typeof window.matchMedia === "function") {
    osMediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
    osMediaListener = () => {
      applyColorSchemeAttribute(ensurePreferenceInitialized());
      notifyOsListeners();
    };
    osMediaQuery.addEventListener("change", osMediaListener);
  }
}

function subscribePreference(listener: () => void) {
  ensureWindowListeners();
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}

function subscribeOs(listener: () => void) {
  ensureWindowListeners();
  osListeners.add(listener);
  return () => {
    osListeners.delete(listener);
  };
}

function writeStoredPreference(value: ColorScheme, keepTransitions = false) {
  const prev = ensurePreferenceInitialized();
  currentPreference = value;
  try {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, value);
  } catch {
    // Keep the in-memory value for this document even if storage is unavailable.
  }
  if (!keepTransitions) {
    disableTransitionsTemporarily();
  }
  applyColorSchemeAttribute(value);
  if (prev !== value) {
    notifyPreferenceListeners();
  }
}

function clearStoredPreference(
  defaultValue: ColorScheme = DEFAULT_COLOR_SCHEME,
  keepTransitions = false,
) {
  const prev = ensurePreferenceInitialized(defaultValue);
  currentPreference = defaultValue;
  try {
    window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
  } catch {
    // Ignore blocked storage.
  }
  if (!keepTransitions) {
    disableTransitionsTemporarily();
  }
  applyColorSchemeAttribute(defaultValue);
  if (prev !== defaultValue) {
    notifyPreferenceListeners();
  }
}

/**
 * Adapter that lets MantineProvider follow this provider's single store without
 * registering its own localStorage/storage listeners or recursing on updates.
 */
export function createMantineColorSchemeManager(
  defaultColorScheme: ColorScheme = DEFAULT_COLOR_SCHEME,
): MantineCompatibleColorSchemeManager {
  let unsubscribeStore: (() => void) | null = null;
  let lastNotified: ColorScheme | null = null;
  return {
    get: (fallback) => ensurePreferenceInitialized(fallback ?? defaultColorScheme),
    set: (value) => {
      if (!isColorScheme(value)) return;
      if (ensurePreferenceInitialized(defaultColorScheme) === value) return;
      lastNotified = value;
      writeStoredPreference(value, true);
    },
    subscribe: (onUpdate) => {
      unsubscribeStore?.();
      lastNotified = ensurePreferenceInitialized(defaultColorScheme);
      unsubscribeStore = subscribePreference(() => {
        const next = ensurePreferenceInitialized(defaultColorScheme);
        if (next === lastNotified) return;
        lastNotified = next;
        onUpdate(next);
      });
    },
    unsubscribe: () => {
      unsubscribeStore?.();
      unsubscribeStore = null;
    },
    clear: () => {
      lastNotified = defaultColorScheme;
      clearStoredPreference(defaultColorScheme, true);
    },
  };
}

/** Test-only reset helper so unit tests start from a clean module state. */
export function resetColorSchemeStoreForTests() {
  preferenceInitialized = false;
  currentPreference = DEFAULT_COLOR_SCHEME;
  if (transitionTimeout !== null && typeof window !== "undefined") {
    window.clearTimeout(transitionTimeout);
    transitionTimeout = null;
  }
  if (storageSubscribed && typeof window !== "undefined") {
    window.removeEventListener("storage", handleStorageEvent);
    storageSubscribed = false;
  }
  if (osMediaQuery && osMediaListener) {
    osMediaQuery.removeEventListener("change", osMediaListener);
    osMediaQuery = null;
    osMediaListener = null;
  }
}

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const ColorSchemeContext = createContext<ColorSchemeContextValue | null>(null);

export function ColorSchemeProvider({
  children,
  defaultColorScheme = DEFAULT_COLOR_SCHEME,
}: Readonly<{
  children: ReactNode;
  defaultColorScheme?: ColorScheme;
}>) {
  const colorScheme = useSyncExternalStore(
    subscribePreference,
    () => ensurePreferenceInitialized(defaultColorScheme),
    () => defaultColorScheme,
  );
  const osColorScheme = useSyncExternalStore(
    subscribeOs,
    readOsColorScheme,
    () => "light" as ResolvedColorScheme,
  );
  const resolvedColorScheme = resolveColorScheme(colorScheme, osColorScheme);

  // Keep the html attribute aligned on mount using the live client value so
  // the SSR server snapshot never briefly overrides the blocking head script.
  useIsomorphicLayoutEffect(() => {
    ensureWindowListeners();
    applyColorSchemeAttribute(ensurePreferenceInitialized(defaultColorScheme));
  }, [defaultColorScheme]);

  const setColorScheme = useCallback(
    (value: ColorScheme, options?: { keepTransitions?: boolean }) => {
      writeStoredPreference(value, options?.keepTransitions);
    },
    [],
  );

  const clearColorScheme = useCallback(
    (options?: { keepTransitions?: boolean }) => {
      clearStoredPreference(defaultColorScheme, options?.keepTransitions);
    },
    [defaultColorScheme],
  );

  const toggleColorScheme = useCallback(() => {
    const live = resolveColorScheme(
      ensurePreferenceInitialized(defaultColorScheme),
      readOsColorScheme(),
    );
    writeStoredPreference(live === "dark" ? "light" : "dark");
  }, [defaultColorScheme]);

  const value = useMemo<ColorSchemeContextValue>(
    () => ({
      colorScheme,
      resolvedColorScheme,
      setColorScheme,
      clearColorScheme,
      toggleColorScheme,
    }),
    [colorScheme, resolvedColorScheme, setColorScheme, clearColorScheme, toggleColorScheme],
  );

  return <ColorSchemeContext.Provider value={value}>{children}</ColorSchemeContext.Provider>;
}

export function useColorScheme(): ColorSchemeContextValue {
  const context = useContext(ColorSchemeContext);
  const fallbackScheme = useSyncExternalStore(
    subscribePreference,
    () => ensurePreferenceInitialized(DEFAULT_COLOR_SCHEME),
    () => DEFAULT_COLOR_SCHEME,
  );
  const fallbackOs = useSyncExternalStore(
    subscribeOs,
    readOsColorScheme,
    () => "light" as ResolvedColorScheme,
  );
  const setColorScheme = useCallback(
    (value: ColorScheme, options?: { keepTransitions?: boolean }) => {
      writeStoredPreference(value, options?.keepTransitions);
    },
    [],
  );
  const clearColorScheme = useCallback((options?: { keepTransitions?: boolean }) => {
    clearStoredPreference(DEFAULT_COLOR_SCHEME, options?.keepTransitions);
  }, []);
  const toggleColorScheme = useCallback(() => {
    const live = resolveColorScheme(ensurePreferenceInitialized(), readOsColorScheme());
    writeStoredPreference(live === "dark" ? "light" : "dark");
  }, []);
  if (context) return context;
  return {
    colorScheme: fallbackScheme,
    resolvedColorScheme: resolveColorScheme(fallbackScheme, fallbackOs),
    setColorScheme,
    clearColorScheme,
    toggleColorScheme,
  };
}

export function useComputedColorScheme(
  defaultValue: ResolvedColorScheme = "light",
): ResolvedColorScheme {
  const colorScheme = useSyncExternalStore(
    subscribePreference,
    () => ensurePreferenceInitialized(DEFAULT_COLOR_SCHEME),
    () => DEFAULT_COLOR_SCHEME,
  );
  const osColorScheme = useSyncExternalStore(
    subscribeOs,
    readOsColorScheme,
    () => defaultValue,
  );
  return resolveColorScheme(colorScheme, osColorScheme);
}
