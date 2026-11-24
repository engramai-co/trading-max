"use client";

import { useSyncExternalStore } from "react";

export type OS =
  | "undetermined"
  | "macos"
  | "ios"
  | "windows"
  | "android"
  | "linux"
  | "chromeos";

export function detectOs(userAgent: string, hasTouchEnd = false): OS {
  const isMacOS = /(Macintosh)|(MacIntel)|(MacPPC)|(Mac68K)/i.test(userAgent);
  const isIOS = /(iPhone)|(iPad)|(iPod)/i.test(userAgent);
  if (isIOS || (isMacOS && hasTouchEnd)) return "ios";
  if (isMacOS) return "macos";
  if (/(Win32)|(Win64)|(Windows)|(WinCE)/i.test(userAgent)) return "windows";
  if (/Android/i.test(userAgent)) return "android";
  if (/CrOS/i.test(userAgent)) return "chromeos";
  if (/Linux/i.test(userAgent)) return "linux";
  return "undetermined";
}

let cachedOs: OS | null = null;

function getClientOs(): OS {
  if (typeof window === "undefined") return "undetermined";
  if (cachedOs === null) {
    cachedOs = detectOs(
      window.navigator.userAgent,
      typeof document !== "undefined" && "ontouchend" in document,
    );
  }
  return cachedOs;
}

const noopSubscribe = () => () => {};
const getServerOs = (): OS => "undetermined";

export function useOs(): OS {
  return useSyncExternalStore(noopSubscribe, getClientOs, getServerOs);
}

export function resetOsCacheForTests() {
  cachedOs = null;
}
