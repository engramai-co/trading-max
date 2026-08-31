"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

import { catalogues, type MessageCatalogue } from "@/lib/i18n/messages";

export type Locale = "zh" | "en";
export type DisplayTimeZonePreference = "browser" | string;

export const DEFAULT_DISPLAY_TIME_ZONE = "Europe/London";

type LocaleContextValue = {
  browserTimeZone: string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  setTimeZonePreference: (timeZone: DisplayTimeZonePreference) => void;
  timeZone: string;
  timeZonePreference: DisplayTimeZonePreference;
};

const STORAGE_KEY = "trading_max-locale";
const TIME_ZONE_STORAGE_KEY = "trading_max-time-zone";
let currentLocale: Locale = "zh";
let currentBrowserTimeZone = DEFAULT_DISPLAY_TIME_ZONE;
let currentTimeZonePreference: DisplayTimeZonePreference = DEFAULT_DISPLAY_TIME_ZONE;
const listeners = new Set<() => void>();
const timeZoneValidity = new Map<string, boolean>();
let storageLoaded = false;

function emitChange() {
  for (const listener of listeners) listener();
}

function applyLocale(locale: Locale) {
  currentLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en-GB";
    document.documentElement.dataset.locale = locale;
  }
}

export function isValidTimeZone(value: string) {
  const cached = timeZoneValidity.get(value);
  if (cached !== undefined) return cached;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format();
    timeZoneValidity.set(value, true);
    return true;
  } catch {
    timeZoneValidity.set(value, false);
    return false;
  }
}

function readBrowserTimeZone() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected && isValidTimeZone(detected)
    ? detected
    : DEFAULT_DISPLAY_TIME_ZONE;
}

function applyTimeZonePreference(preference: DisplayTimeZonePreference) {
  currentTimeZonePreference = preference === "browser" || isValidTimeZone(preference)
    ? preference
    : DEFAULT_DISPLAY_TIME_ZONE;
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (!storageLoaded && typeof window !== "undefined") {
    storageLoaded = true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const nextLocale: Locale = stored === "en" ? "en" : "zh";
    applyLocale(nextLocale);
    currentBrowserTimeZone = readBrowserTimeZone();
    applyTimeZonePreference(
      window.localStorage.getItem(TIME_ZONE_STORAGE_KEY) || DEFAULT_DISPLAY_TIME_ZONE,
    );
    queueMicrotask(emitChange);
  }

  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentLocale;
}

function getServerSnapshot(): Locale {
  return "zh";
}

function getTimeZoneSnapshot() {
  return currentTimeZonePreference;
}

function getTimeZoneServerSnapshot(): DisplayTimeZonePreference {
  return DEFAULT_DISPLAY_TIME_ZONE;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const setLocale = useCallback((nextLocale: Locale) => {
    applyLocale(nextLocale);
    window.localStorage.setItem(STORAGE_KEY, nextLocale);
    emitChange();
  }, []);
  const timeZonePreference = useSyncExternalStore(
    subscribe,
    getTimeZoneSnapshot,
    getTimeZoneServerSnapshot,
  );
  const setTimeZonePreference = useCallback((nextTimeZone: DisplayTimeZonePreference) => {
    applyTimeZonePreference(nextTimeZone);
    window.localStorage.setItem(TIME_ZONE_STORAGE_KEY, currentTimeZonePreference);
    emitChange();
  }, []);
  const timeZone = timeZonePreference === "browser"
    ? currentBrowserTimeZone
    : timeZonePreference;

  return (
    <LocaleContext.Provider value={{
      browserTimeZone: currentBrowserTimeZone,
      locale,
      setLocale,
      setTimeZonePreference,
      timeZone,
      timeZonePreference,
    }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) {
    throw new Error("useLocale must be used inside LocaleProvider");
  }
  return value;
}

/**
 * Access the bilingual message catalogue for the active locale. Prefer this
 * over inline `zh`/`en` pairs for plain strings so translations stay reviewable
 * in one place and a missing key fails at build time.
 */
export function useMessages(): MessageCatalogue {
  const { locale } = useLocale();
  return catalogues[locale];
}

export function Localized({
  zh,
  en,
}: {
  zh: React.ReactNode;
  en: React.ReactNode;
}) {
  const { locale } = useLocale();
  return <>{locale === "zh" ? zh : en}</>;
}
