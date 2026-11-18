/** A remembered control can become disabled, hidden or inert while the panel changes. */
export function focusAssistantControl(...candidates: (HTMLElement | null | undefined)[]) {
  for (const control of candidates) {
    if (!control?.isConnected || control.matches(":disabled") || control.closest("[hidden], [inert], [aria-hidden=true]")) continue;
    if (!control.getClientRects().length || getComputedStyle(control).visibility !== "visible") continue;
    if (document.activeElement !== control) control.focus({preventScroll:true});
    if (document.activeElement === control) return true;
  }
  return false;
}
