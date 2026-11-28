import { createContext } from "react";

export const CitationReturnFocus = createContext<(source: HTMLElement | null, touch: boolean) => HTMLElement | null>(source => source);

export function canFocusAssistantControl(control: HTMLElement | null | undefined): control is HTMLElement {
  return Boolean(control?.isConnected && !control.matches(":disabled") && !control.closest("[hidden], [inert], [aria-hidden=true]") &&
    control.getClientRects().length && getComputedStyle(control).visibility === "visible");
}

/** Restore a remembered control without moving the workspace or History scroll position. */
export function focusAssistantControl(...candidates: (HTMLElement | null | undefined)[]) {
  for (const control of candidates) {
    if (!canFocusAssistantControl(control)) continue;
    if (document.activeElement !== control) control.focus({preventScroll:true});
    if (document.activeElement === control) return true;
  }
  return false;
}
