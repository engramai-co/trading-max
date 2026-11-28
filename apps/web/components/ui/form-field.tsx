"use client";

import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type FocusEvent, type ReactNode } from "react";
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
  const feedback = error && <FieldError id={errorId}><CircleAlert className="size-4 shrink-0" aria-hidden="true" />{error}</FieldError>;
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
            {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    )}
  </FormField>;
}

/**
 * Tracks submit and post-interaction blur validation on required fields, providing
 * Safari 16.4-compatible `:user-invalid` timing and polite delayed announcements on blur.
 */
export function useRequiredFields() {
  const [attempted, setAttempted] = useState(false);
  const [blurred, setBlurred] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const editedRef = useRef(new Set<string>());
  const announcedRef = useRef<{ field: string | null; timer: number | null }>({ field: null, timer: null });

  function clearAnnouncement(field?: string) {
    if (field && announcedRef.current.field !== field) return;
    if (announcedRef.current.timer !== null) {
      window.clearTimeout(announcedRef.current.timer);
      announcedRef.current.timer = null;
    }
    announcedRef.current.field = null;
    setAnnouncement("");
  }

  useEffect(() => () => {
    if (announcedRef.current.timer !== null) window.clearTimeout(announcedRef.current.timer);
  }, []);

  return {
    reset() {
      setAttempted(false);
      setBlurred(new Set());
      editedRef.current.clear();
      clearAnnouncement();
    },
    markEdited(field: string, value?: string) {
      editedRef.current.add(field);
      if (value !== undefined && value.trim()) clearAnnouncement(field);
    },
    markBlurred(field: string, value: string, message: string, event?: FocusEvent<HTMLElement>) {
      if (!editedRef.current.has(field)) return;
      const nextTarget = event?.relatedTarget instanceof Element ? event.relatedTarget : null;
      // Avoid shifting a submit or reveal button out from under a pointer click during blur.
      if (nextTarget?.closest('button[type="submit"], button.tm-field-reveal')) return;
      setBlurred((current) => {
        if (current.has(field)) return current;
        const next = new Set(current);
        next.add(field);
        return next;
      });
      if (!value.trim()) {
        if (announcedRef.current.timer !== null) window.clearTimeout(announcedRef.current.timer);
        setAnnouncement("");
        announcedRef.current.field = field;
        announcedRef.current.timer = window.setTimeout(() => {
          announcedRef.current.timer = null;
          setAnnouncement(message);
        }, 500);
      } else {
        clearAnnouncement(field);
      }
    },
    missing: (value: string, field?: string) =>
      (attempted || (field !== undefined && blurred.has(field))) && !value.trim(),
    validate(form: HTMLFormElement | null) {
      if (!form) return false;
      const first = Array.from(form.querySelectorAll<HTMLInputElement>("input[required]:enabled"))
        .find(control => !control.value.trim());
      if (first) {
        // Focus moving to the first invalid field announces its error directly.
        clearAnnouncement();
        flushSync(() => setAttempted(true));
        first.focus();
      }
      return !first;
    },
    liveRegion: (
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    ),
  };
}
