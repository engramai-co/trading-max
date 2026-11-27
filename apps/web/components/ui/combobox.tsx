"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

const Combobox = ComboboxPrimitive.Root;
const ComboboxCollection = ComboboxPrimitive.Collection;
const ComboboxGroup = ComboboxPrimitive.Group;
const ComboboxChips = ComboboxPrimitive.Chips;
const ComboboxInputGroup = ComboboxPrimitive.InputGroup;

function ComboboxTrigger(props: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger data-slot="combobox-trigger" className="tm-picker-action" {...props}>
      <ChevronDown size={16} aria-hidden="true" className="tm-picker-chevron" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear(props: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear data-slot="combobox-clear" className="tm-picker-action" {...props}>
      <X size={16} aria-hidden="true" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxInput(props: ComboboxPrimitive.Input.Props) {
  return <ComboboxPrimitive.Input data-slot="combobox-input" className="tm-combobox-input" {...props} />;
}

function ComboboxContent({ anchor, children, container }: {
  anchor: ComboboxPrimitive.Positioner.Props["anchor"];
  children: React.ReactNode;
  container?: ComboboxPrimitive.Portal.Props["container"];
}) {
  return (
    <ComboboxPrimitive.Portal container={container}>
      <ComboboxPrimitive.Positioner anchor={anchor} align="start" sideOffset={8} className="tm-floating-position">
        <ComboboxPrimitive.Popup data-slot="combobox-content" className="tm-floating-surface tm-picker-popup">
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList(props: ComboboxPrimitive.List.Props) {
  return <ComboboxPrimitive.List data-slot="combobox-list" className="tm-picker-list" {...props} />;
}

function ComboboxItem({ children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item data-slot="combobox-item" className="tm-picker-item" {...props}>
      <span className="tm-picker-item-text">{children}</span>
      <ComboboxPrimitive.ItemIndicator className="tm-picker-check">
        <Check size={16} aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxLabel(props: ComboboxPrimitive.GroupLabel.Props) {
  return <ComboboxPrimitive.GroupLabel className="tm-picker-group-label" {...props} />;
}

function ComboboxEmpty(props: ComboboxPrimitive.Empty.Props) {
  return <ComboboxPrimitive.Empty className="tm-picker-empty" {...props} />;
}

function ComboboxChip({ className, children, removeLabel, ...props }: ComboboxPrimitive.Chip.Props & {
  removeLabel?: string;
}) {
  return (
    <ComboboxPrimitive.Chip data-slot="picker-chip" className={cn("tm-picker-chip", className)} {...props}>
      {children}
      {removeLabel && (
        <ComboboxPrimitive.ChipRemove aria-label={removeLabel} className="tm-picker-remove">
          <X size={16} aria-hidden="true" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

export {
  Combobox, ComboboxChip, ComboboxChips, ComboboxClear, ComboboxCollection, ComboboxContent,
  ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxInputGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxTrigger,
};
