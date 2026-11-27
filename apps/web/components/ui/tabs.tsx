"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";

export function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList(props: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" {...props} />;
}

export function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Tab>) {
  return <TabsPrimitive.Tab data-slot="tabs-trigger" {...props} />;
}

export function TabsContent(props: ComponentProps<typeof TabsPrimitive.Panel>) {
  return <TabsPrimitive.Panel data-slot="tabs-content" {...props} />;
}
