import type { Locale } from "@/components/locale-provider";
import { number } from "../data";

export type ReplyMove = { text: string; tone: "gain" | "loss" };

export function replyMove(value: number, locale: Locale, digits = 2): ReplyMove | undefined {
  if (!value) return undefined;
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const direction = value < 0 ? t("下跌", "down") : t("上涨", "up");
  const percentage = number(Math.abs(value) * 100, digits);
  const amount = percentage === "0" ? t("不到 0.1%", " less than 0.1%") : " " + percentage + "%";
  return {text: direction + amount, tone: value < 0 ? "loss" : "gain"};
}
