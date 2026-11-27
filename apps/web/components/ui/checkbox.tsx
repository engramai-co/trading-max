"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Check, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

function Checkbox({
  className,
  description,
  label,
  indeterminate,
  id,
  ...props
}: CheckboxPrimitive.Root.Props & { label: ReactNode; description?: ReactNode }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = controlId + "-label";
  const descriptionId = description ? controlId + "-description" : undefined;
  return (
    <label className={cn("tm-choice-label", className)} htmlFor={controlId} data-disabled={props.disabled || undefined}>
      <CheckboxPrimitive.Root
        {...props}
        id={controlId}
        nativeButton
        render={<button type="button" />}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        indeterminate={indeterminate}
        data-slot="checkbox"
      >
        <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
          {indeterminate ? <Minus size={14} /> : <Check size={14} />}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span>
        <span id={labelId}>{label}</span>
        {description && <small id={descriptionId} className="tm-choice-description">{description}</small>}
      </span>
    </label>
  );
}

export { Checkbox, CheckboxGroup };
