"use client";

import { useSyncExternalStore } from "react";

const key = "trading_max-performance-benchmark";
const values = ["VOO", "QQQ", "VT", "ALL"];
const changed = "tm-benchmark-changed";
export function benchmarkValue(value: string | null) {
  return value && values.includes(value) ? value : null;
}
function read() {
  try { return benchmarkValue(localStorage.getItem(key)) ?? "VOO"; } catch { return "VOO"; }
}
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(changed, notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener(changed, notify); };
}
export function usePerformanceBenchmark() {
  return useSyncExternalStore(subscribe, read, () => "VOO");
}
export function rememberBenchmark(value: string) {
  try { localStorage.setItem(key, benchmarkValue(value) ?? "VOO"); } catch {}
  window.dispatchEvent(new Event(changed));
}
