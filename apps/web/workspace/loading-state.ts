import type { Locale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";

export const LOADING_STATUS_MS = 800;

export function scheduleLoadingStatus(show: () => void) {
  const timer = setTimeout(show, LOADING_STATUS_MS);
  return () => clearTimeout(timer);
}

export function previousForIdentity<T>(previous: T, previousIdentity: unknown, identity: unknown): T | undefined {
  return previousIdentity === identity ? previous : undefined;
}

export function updateFailureLabel(updatedAt: number, locale: Locale, timeZone: string) {
  const time = formatDate(updatedAt, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return locale === "zh" ? `更新失败 · 上次成功 ${time}` : `Update failed · last success ${time}`;
}
