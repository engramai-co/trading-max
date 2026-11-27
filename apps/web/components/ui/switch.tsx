"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { LoaderCircle } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

function Switch({
  className,
  label,
  labelPosition = "right",
  saving,
  id,
  ...props
}: SwitchPrimitive.Root.Props & {
  label?: ReactNode;
  labelPosition?: "left" | "right";
  saving?: boolean;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = label ? controlId + "-label" : undefined;
  const control = (
    <SwitchPrimitive.Root
      {...props}
      id={controlId}
      nativeButton
      render={<button type="button" />}
      aria-busy={saving || props["aria-busy"]}
      aria-labelledby={props["aria-labelledby"] ?? labelId}
      data-slot="switch"
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb">
        {saving && <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
  return label ? (
    <label className={cn("tm-choice-label", className)} htmlFor={controlId} data-disabled={props.disabled || undefined}>
      {labelPosition === "left" && <span id={labelId}>{label}</span>}
      {control}
      {labelPosition === "right" && <span id={labelId}>{label}</span>}
    </label>
  ) : (
    <span className={cn("tm-choice-label", className)} data-disabled={props.disabled || undefined} data-standalone="">
      {control}
    </span>
  );
}

export { Switch };
