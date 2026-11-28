"use client";

import { type KeyboardEvent } from "react";
import { isImeComposing } from "./shortcut-platform";

/** Shared Luma Tailwind classes for Settings surfaces (replacing the Settings sections of 05 and 07 CSS). */
export const settingsConnectionGridClass =
  "grid grid-cols-2 gap-[18px] max-[767px]:grid-cols-1 max-[767px]:gap-x-3 max-[767px]:gap-y-0";

export const settingsModelGridClass =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-[18px] max-[767px]:grid-cols-1 max-[767px]:gap-x-3 max-[767px]:gap-y-0";

export const settingsConnectionCardClass = [
  "flex flex-col gap-3 rounded-[var(--radius-heat-tile)] border border-border bg-background p-[22px]",
  "max-[767px]:gap-2 max-[767px]:rounded-none max-[767px]:border-0 max-[767px]:bg-transparent max-[767px]:px-0 max-[767px]:py-3",
  "max-[767px]:[&:not(:first-child)]:border-t max-[767px]:[&:not(:first-child)]:border-border",
].join(" ");

export const settingsConnectionTitleClass =
  "min-w-0 wrap-anywhere text-xl leading-[1.55] font-[550] tracking-[-0.02em] text-foreground max-[767px]:text-[0.9375rem] max-[767px]:leading-[1.45] max-[767px]:font-semibold";

export const settingsConnectionCopyClass =
  "wrap-anywhere text-xs leading-[1.7] text-muted-foreground max-[767px]:text-[0.8125rem] max-[767px]:leading-[1.5]";

export const settingsRowClass = [
  "flex items-center justify-between gap-6 border-b border-border py-[22px] first:pt-0 last:border-b-0 last:pb-0",
  "max-[767px]:gap-3 max-[767px]:py-3 max-[767px]:first:pt-0 max-[767px]:last:pb-3",
].join(" ");

export const settingsRowHeadingClass =
  "text-sm leading-[1.55] font-semibold text-foreground max-[767px]:text-[0.9375rem] max-[767px]:leading-[1.45]";

export const settingsRowCopyClass =
  "my-[7px] text-xs leading-[1.8] text-muted-foreground max-[767px]:my-1 max-[767px]:text-[0.8125rem] max-[767px]:leading-[1.5]";

export const settingsSwitchRowClass =
  "min-w-0 flex-1 justify-between font-semibold -my-[9px] pointer-coarse:-my-[11px]";

export const settingsSwitchOffsetClass =
  "-my-[9px] pointer-coarse:-my-[11px]";

export const settingsFormGridClass =
  "mt-4 grid grid-cols-2 gap-5 max-[767px]:grid-cols-1";

export const settingsDangerZoneClass =
  "mt-4 border-t border-border pt-6";

export const settingsRetryLinkClass = [
  "mx-text-link border-0 bg-transparent p-0 text-[color-mix(in_srgb,var(--link)_78%,var(--foreground))]",
  "-my-2.5 pointer-coarse:min-h-11 pointer-coarse:-my-3",
].join(" ");

export const settingsImportDropClass = [
  "mx-import-drop grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[18px] gap-y-3 rounded-[var(--radius-heat-tile)]",
  "border border-dashed border-border bg-background p-[22px]",
  "[&>.tm-file-picker]:col-start-2",
  "max-[767px]:grid-cols-1 max-[767px]:p-[18px] max-[767px]:[&>.tm-file-picker]:col-start-1",
].join(" ");

export const settingsBrokerKeyHelpClass =
  "text-[13px] [&_summary]:cursor-pointer [&_summary]:text-link [&_p]:my-2 [&_p]:text-muted-foreground";

export const settingsDetailsBodyClass =
  "[&_p]:my-2 [&_p]:text-xs [&_p]:leading-[1.7] [&_p]:text-muted-foreground [&_a]:text-xs [&_a]:text-link";

/** Stops Safari's IME confirmation keydown from reaching an implicit submit. */
export function guardSettingsFormEnter(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key === "Enter" && isImeComposing(event)) event.preventDefault();
}
