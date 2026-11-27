"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { RefAttributes } from "react";

export function RadioGroup<Value extends string>(
  props: RadioGroupPrimitive.Props<Value> & RefAttributes<HTMLDivElement>,
) {
  return <RadioGroupPrimitive data-slot="radio-group" {...props} />;
}

export function RadioGroupItem<Value extends string>(
  props: RadioPrimitive.Root.Props<Value>,
) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      nativeButton
      render={<button type="button" />}
      {...props}
    />
  );
}
