"use client";

import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import { useBuildNavigationGuard } from "@/ui/publication-provider";
import type { ModelRoutingDraft, PreferencesDraft } from "./settings-drafts";

type LanguageEdit = { previous: Locale; selected: Locale };
type DraftSetter<T> = Dispatch<SetStateAction<T>>;

type SettingsDrafts = {
  preferences: PreferencesDraft | undefined;
  setPreferences: DraftSetter<PreferencesDraft | undefined>;
  routing: ModelRoutingDraft | undefined;
  setRouting: DraftSetter<ModelRoutingDraft | undefined>;
  language: LanguageEdit | undefined;
  setLanguage: DraftSetter<LanguageEdit | undefined>;
  cfdFile: File | null;
  setCfdFile: DraftSetter<File | null>;
};

const DraftContext = createContext<SettingsDrafts | null>(null);

/** The parent provider is keyed by workspace scope. All entries live only in this document. */
export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  const [preferences, setPreferences] = useState<PreferencesDraft>();
  const [routing, setRouting] = useState<ModelRoutingDraft>();
  const [language, setLanguage] = useState<LanguageEdit>();
  const [cfdFile, setCfdFile] = useState<File | null>(null);

  // A shell language change supersedes the Settings preview, including while Settings is away.
  if (language && language.selected !== locale) setLanguage(undefined);

  const dirty = Boolean(preferences || routing || language || cfdFile);
  useBuildNavigationGuard(dirty);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  return <DraftContext.Provider value={{
    preferences, setPreferences, routing, setRouting, language, setLanguage, cfdFile, setCfdFile,
  }}>{children}</DraftContext.Provider>;
}

export function useSettingsDrafts() {
  const drafts = useContext(DraftContext);
  if (!drafts) throw new Error("Settings drafts require a workspace provider.");
  return drafts;
}
