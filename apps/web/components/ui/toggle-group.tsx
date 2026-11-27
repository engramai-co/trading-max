"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { ComponentProps, RefAttributes } from "react";
import { Toggle } from "@/components/ui/toggle";

export function ToggleGroup<Value extends string>(props: ToggleGroupPrimitive.Props<Value> & RefAttributes<HTMLDivElement>) {
  return <ToggleGroupPrimitive data-slot="toggle-group" {...props} />;
}

export function ToggleGroupItem(props: ComponentProps<typeof Toggle>) {
  return <Toggle data-slot="toggle-group-item" {...props} />;
}
