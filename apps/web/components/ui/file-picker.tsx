"use client";

import { useRef } from "react";
import { CloseButton } from "./button";
import { Input } from "./input";
import { InputGroup } from "./input-group";

export function FilePicker({ value, accept, placeholder, chosenLabel, clearLabel, disabled, onChange }: {
  value: File | null;
  accept: string;
  placeholder: string;
  chosenLabel: string;
  clearLabel: string;
  disabled?: boolean;
  onChange: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <InputGroup className="tm-file-picker" data-disabled={disabled || undefined}>
      <Input type="file" className="sr-only" ref={input} tabIndex={-1} aria-hidden="true"
        accept={accept} disabled={disabled} onChange={event => {
          onChange(event.currentTarget.files?.[0] ?? null);
          event.currentTarget.value = "";
        }} />
      <button type="button" ref={trigger} disabled={disabled}
        className="min-w-0 flex-1 truncate rounded-full px-3.5 text-start text-sm"
        data-placeholder={!value || undefined}
        aria-label={value ? chosenLabel + value.name : undefined}
        onClick={() => input.current?.click()}>{value?.name ?? placeholder}</button>
      {value && <CloseButton aria-label={clearLabel} disabled={disabled}
        onClick={() => { onChange(null); trigger.current?.focus(); }} />}
    </InputGroup>
  );
}
