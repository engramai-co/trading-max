"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { ComponentProps } from "react";

export function Toggle(props: ComponentProps<typeof TogglePrimitive>) {
  return <TogglePrimitive data-slot="toggle" {...props} />;
}
