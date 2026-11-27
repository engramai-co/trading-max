"use client";

import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button } from "./button";
import { Field, FieldDescription, FieldError, FieldLabel } from "./field";
import { identifierHints, Input } from "./input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";
import { Textarea } from "./textarea";

type FieldCopy = {
  label?: ReactNode;
  description?: ReactNode;
  error?: string;
  fieldClassName?: string;
};

type FieldAttributes = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

export function FormField({
  label, description, error, fieldClassName, id: explicitId, describedBy, required, disabled, announceError, children,
}: FieldCopy & {
  id?: string;
  describedBy?: string;
  required?: boolean;
  disabled?: boolean;
  announceError?: boolean;
  children: (attributes: FieldAttributes) => ReactNode;
}) {
  const autoId = useId();
  const id = explicitId ?? autoId;
  const descriptionId = description ? id + "-description" : undefined;
  const errorId = error ? id + "-error" : undefined;
  const attributes = {
    id,
    "aria-describedby": [describedBy, descriptionId, errorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": error ? true : required ? false : undefined,
  };
  const feedback = error && <FieldError id={errorId}><CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />{error}</FieldError>;
  return (
    <Field className={fieldClassName} data-invalid={Boolean(error) || undefined} data-disabled={disabled || undefined}>
      {label && <div className="leading-[1.55]">
        <FieldLabel htmlFor={id} className="mb-1.5 inline-block max-w-full wrap-anywhere text-xs leading-[1.55] font-[550] max-[767px]:font-medium">
          {label}{required && <span className="ms-1 text-warning" aria-hidden="true">*</span>}
        </FieldLabel>
      </div>}
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      {children(attributes)}
      {announceError ? <div aria-live="polite">{feedback}</div> : feedback}
    </Field>
  );
}

export function TextField({
  label, description, error, fieldClassName, id, "aria-describedby": describedBy, ...props
}: ComponentProps<typeof Input> & FieldCopy) {
  return <FormField {...{ label, description, error, fieldClassName, id, describedBy }} required={props.required} disabled={props.disabled}>
    {attributes => <Input {...props} {...attributes} />}
  </FormField>;
}

export function TextareaField({
  label, description, error, fieldClassName, id, "aria-describedby": describedBy, ...props
}: ComponentProps<typeof Textarea> & FieldCopy) {
  return <FormField {...{ label, description, error, fieldClassName, id, describedBy }} required={props.required} disabled={props.disabled}>
    {attributes => <Textarea {...props} {...attributes} />}
  </FormField>;
}

export function CredentialField({
  label, error, revealLabel, autoComplete = "off", ...props
}: ComponentProps<typeof Input> & {
  label: ReactNode;
  error?: string;
  revealLabel: string;
  name: string;
}) {
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<{ start: number; end: number; direction?: "forward" | "backward" | "none" }>(null);
  useLayoutEffect(() => {
    const saved = selection.current;
    if (saved) input.current?.setSelectionRange(saved.start, saved.end, saved.direction);
    selection.current = null;
  }, [visible]);

  return <FormField label={label} error={error} required disabled={props.disabled}>
    {attributes => (
      <InputGroup data-disabled={props.disabled || undefined}>
        <InputGroupInput {...identifierHints} {...props} {...attributes} ref={input} required
          type={visible ? "text" : "password"} autoComplete={autoComplete} />
        <InputGroupAddon align="inline-end">
          <Button type="button" variant="ghost" size="icon" className="tm-field-reveal" disabled={props.disabled}
            aria-label={revealLabel} aria-pressed={visible}
            onMouseDown={event => { if (document.activeElement === input.current) event.preventDefault(); }}
            onClick={() => {
              const control = input.current;
              if (control?.selectionStart != null && control.selectionEnd != null) {
                selection.current = { start: control.selectionStart, end: control.selectionEnd, direction: control.selectionDirection ?? undefined };
              }
              setVisible(current => !current);
            }}>
            {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    )}
  </FormField>;
}

/** A submit attempt exposes recovery text only on fields that still need a value. */
export function useRequiredFields() {
  const [attempted, setAttempted] = useState(false);
  return {
    reset: () => setAttempted(false),
    missing: (value: string) => attempted && !value.trim(),
    validate(form: HTMLFormElement | null) {
      if (!form) return false;
      const first = Array.from(form.querySelectorAll<HTMLInputElement>("input[required]:enabled"))
        .find(control => !control.value.trim());
      if (first) {
        flushSync(() => setAttempted(true));
        first.focus();
      }
      return !first;
    },
  };
}
