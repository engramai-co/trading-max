"use client";

import { Toolbar } from "@base-ui/react/toolbar";
import { isImeComposing } from "./shortcut-platform";

export function ChartToolbar(props: Toolbar.Root.Props) {
  return <Toolbar.Root
    {...props}
    onKeyDown={(event) => {
      if (isImeComposing(event) || event.defaultPrevented || !["Home", "End"].includes(event.key)) return;
      if (!(event.target instanceof HTMLElement) || event.target.closest('[role="toolbar"]') !== event.currentTarget
        || event.target.closest('[role="menu"]')) return;
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const target = event.key === "Home" ? buttons[0] : buttons[buttons.length - 1];
      if (!target) return;
      event.preventDefault();
      target.focus();
    }}
  />;
}
