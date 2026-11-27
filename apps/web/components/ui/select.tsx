"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger data-slot="select-trigger"
      className={cn("tm-field-control tm-select-trigger", className)} {...props}>
      {children}
      <ChevronDown size={16} aria-hidden="true" className="tm-picker-chevron" />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ anchor, children, container, intrinsic, "aria-label": label }: {
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
  children: React.ReactNode;
  container?: SelectPrimitive.Portal.Props["container"];
  "aria-label"?: string;
  intrinsic?: boolean;
}) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner anchor={anchor} className="tm-floating-position" align="start" sideOffset={8} alignItemWithTrigger={false}>
        <SelectPrimitive.Popup data-slot="select-content" data-intrinsic={intrinsic || undefined}
          className="tm-floating-surface tm-picker-popup" onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            const options = event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
            if (options.length < 2) return;
            const first = options[0];
            const last = options[options.length - 1];
            const up = event.key === "ArrowUp";
            if ((up ? first : last) !== event.target) return;
            // Preserve the previous wrap at the ends; Base UI handles navigation inside the list.
            event.preventDefault();
            event.preventBaseUIHandler();
            const list = event.currentTarget.querySelector<HTMLElement>('[role="listbox"]');
            if (list) list.scrollTop = up ? list.scrollHeight : 0;
            (up ? last : first).focus({ preventScroll: true });
          }}>
          <SelectPrimitive.List className="tm-picker-list" aria-label={label}>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel(props: SelectPrimitive.GroupLabel.Props) {
  return <SelectPrimitive.GroupLabel className="tm-picker-group-label" {...props} />;
}

function SelectItem({ children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className="tm-picker-item" {...props}>
      <SelectPrimitive.ItemText className="tm-picker-item-text">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="tm-picker-check">
        <Check size={16} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue };
