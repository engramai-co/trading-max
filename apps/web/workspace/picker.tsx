"use client";

import {
  useCallback, useContext, useId, useMemo, useRef, useState, type ChangeEventHandler, type CSSProperties, type ReactNode, type Ref, type RefObject,
} from "react";
import { X } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxClear, ComboboxCollection, ComboboxContent, ComboboxEmpty,
  ComboboxGroup, ComboboxInput, ComboboxInputGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxTrigger,
} from "@/components/ui/combobox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { FieldLabel } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCopy } from "./foundation";
import { OverlayPopupContainer } from "./overlay";
import { isImeComposing } from "./shortcut-platform";

type Option = { value: string; label: string; disabled?: boolean };
type OptionGroup = { group?: string; items: Option[] };
type Options = readonly (Option | OptionGroup | string)[];
type FieldProps = {
  label?: string;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  options: Options;
};
type SingleProps = FieldProps & {
  value?: string | null;
  onChange?: (value: string | null) => void;
  clearable?: boolean;
  clearLabel?: string;
  "data-autofocus"?: boolean;
};
type MultipleProps = FieldProps & {
  value: string[];
  onChange: (value: string[]) => void;
  maxValues?: number;
  canRemove?: (option: Option) => boolean;
  removeLabel?: (option: Option) => string;
  optionName?: (option: Option) => string;
};

function groupsFor(options: Options): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const option of options) {
    if (typeof option !== "string" && "items" in option) {
      groups.push({ ...option, items: [...option.items] });
    } else {
      const item = typeof option === "string" ? { value: option, label: option } : option;
      const group = groups.at(-1);
      if (group && !group.group) group.items.push(item);
      else groups.push({ items: [item] });
    }
  }
  return groups;
}

// Keep only the committed selections as options are refreshed or temporarily unavailable.
function useSelectedOptions(items: Option[], values: readonly string[]) {
  const [previous, setPrevious] = useState<Option[]>([]);
  const selected = values.flatMap(value => {
    const item = items.find(option => option.value === value) ?? previous.find(option => option.value === value);
    return item ? [item] : [];
  });
  if (selected.length !== previous.length || selected.some((item, index) => (
    item.value !== previous[index].value || item.label !== previous[index].label || item.disabled !== previous[index].disabled
  ))) {
    setPrevious(selected);
  }
  return selected;
}

function PickerField({ id, label, className, style, children, intrinsic }: {
  id: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  intrinsic?: boolean;
}) {
  return (
    <div data-slot="picker" data-intrinsic={intrinsic || undefined} className={cn("tm-picker", className)} style={style}>
      {label && <div className="leading-[1.55]">
        <FieldLabel htmlFor={id} className="mb-1.5 inline-block max-w-full wrap-anywhere text-xs leading-[1.55] font-[550] max-[767px]:font-medium">
          {label}
        </FieldLabel>
      </div>}
      {children}
    </div>
  );
}

function SelectOptions({ groups, optionName }: { groups: OptionGroup[]; optionName?: (option: Option) => string }) {
  return groups.map(({ group, items }, index) => {
    const options = items.map((item) => (
      <SelectItem key={item.value} value={item.value} disabled={item.disabled} label={item.label}
        aria-label={optionName?.(item)}>
        {item.label}
      </SelectItem>
    ));
    return group ? <SelectGroup key={group}><SelectLabel>{group}</SelectLabel>{options}</SelectGroup> : (
      <SelectGroup key={index}>{options}</SelectGroup>
    );
  });
}

export function SelectPicker({
  options, value, onChange, onSelect, label, "aria-label": ariaLabel, className, style,
  disabled, readOnly, placeholder, clearable, clearLabel, intrinsic, widthLabels, ref, "data-autofocus": autoFocus,
}: SingleProps & {
  intrinsic?: boolean;
  widthLabels?: Readonly<Record<string, string>>;
  ref?: Ref<HTMLButtonElement>;
  onSelect?: (value: string) => void;
}) {
  const id = useId();
  const t = useCopy();
  const trigger = useRef<HTMLButtonElement>(null);
  const setTrigger = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
    if (typeof ref === "function") return ref(element);
    if (ref) ref.current = element;
  }, [ref]);
  const container = useContext(OverlayPopupContainer);
  const groups = useMemo(() => groupsFor(options), [options]);
  const items = groups.flatMap((group) => group.items);
  const [selected] = useSelectedOptions(items, value == null ? [] : [value]);
  const canClear = clearable && value != null && !disabled && !readOnly;

  return (
    <PickerField {...{ id, label, className, style, intrinsic }}>
      <Select<string> items={items} value={value ?? null} disabled={disabled} readOnly={readOnly} modal={false}
        onOpenChange={(open, details) => { if (open && (readOnly || !items.length)) details.cancel(); }}
        onValueChange={(next, details) => {
          if (onSelect && next !== null && details.reason === "item-press") {
            // Base UI can focus the option during this click. Return focus before the model changes the layout.
            queueMicrotask(() => {
              if (!trigger.current) return;
              trigger.current.focus({ preventScroll: true });
              onSelect(next);
              if (next !== value) onChange?.(next);
            });
          } else if (next !== value) {
            if (onSelect && next !== null && details.reason === "none") onSelect(next);
            onChange?.(next);
          }
        }}>
        <div className="tm-select-control" data-clearable={canClear || undefined}>
          {intrinsic && <span className="tm-select-width" aria-hidden="true">
            {items.map((item) => <span key={item.value}>{widthLabels?.[item.value] ?? item.label}</span>)}
          </span>}
          <SelectTrigger id={id} aria-label={ariaLabel} data-autofocus={autoFocus || undefined} ref={setTrigger}>
            <SelectValue className="tm-select-value" data-empty={!selected || undefined}>
              {() => selected?.label ?? placeholder}
            </SelectValue>
          </SelectTrigger>
          {canClear && <button type="button" tabIndex={-1} className="tm-picker-action tm-select-clear"
            aria-label={clearLabel ?? t("清除", "Clear")} onClick={() => {
              trigger.current?.focus({ preventScroll: true });
              onChange?.(null);
            }}><X size={16} aria-hidden="true" /></button>}
        </div>
        <SelectContent container={container} aria-label={ariaLabel ?? label} intrinsic={intrinsic}><SelectOptions groups={groups} /></SelectContent>
      </Select>
    </PickerField>
  );
}

function ComboOptions({ anchor, label, renderOption, nothingFoundMessage }: {
  anchor: RefObject<HTMLDivElement | null>;
  label?: string;
  renderOption?: (option: Option) => ReactNode;
  nothingFoundMessage?: string;
}) {
  const container = useContext(OverlayPopupContainer);
  const renderItem = (item: Option) => (
    <ComboboxItem key={item.value} value={item} disabled={item.disabled}>
      {renderOption ? renderOption(item) : item.label}
    </ComboboxItem>
  );
  return (
    <ComboboxContent anchor={anchor} container={container}>
      {nothingFoundMessage && <ComboboxEmpty>{nothingFoundMessage}</ComboboxEmpty>}
      <ComboboxList aria-label={label}>
        {(group: OptionGroup) => group.group ? (
          <ComboboxGroup key={group.group} items={group.items}>
            <ComboboxLabel>{group.group}</ComboboxLabel>
            <ComboboxCollection>{renderItem}</ComboboxCollection>
          </ComboboxGroup>
        ) : group.items.map(renderItem)}
      </ComboboxList>
    </ComboboxContent>
  );
}

export function SearchPicker({
  options, value, onChange, label, "aria-label": ariaLabel, className, style, disabled, readOnly,
  placeholder, clearable, clearLabel, nothingFoundMessage, renderOption,
}: SingleProps & {
  nothingFoundMessage?: string;
  renderOption?: (option: Option) => ReactNode;
}) {
  const id = useId();
  const t = useCopy();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const replayingOtherField = useRef(false);
  const setInput = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    let reset: ReturnType<typeof setTimeout>;
    function rememberHistory(event: InputEvent) {
      if ((event.inputType === "historyUndo" || event.inputType === "historyRedo") &&
          event.currentTarget !== input?.ownerDocument.activeElement) {
        // A document-wide undo can briefly return focus here to replay an old edit.
        replayingOtherField.current = true;
        clearTimeout(reset);
        reset = setTimeout(() => { replayingOtherField.current = false; }, 0);
      }
    }
    input.addEventListener("beforeinput", rememberHistory);
    return () => {
      clearTimeout(reset);
      replayingOtherField.current = false;
      input.removeEventListener("beforeinput", rememberHistory);
    };
  }, []);
  const groups = useMemo(() => groupsFor(options), [options]);
  const [known] = useSelectedOptions(groups.flatMap((group) => group.items), value == null ? [] : [value]);
  const selected = known ?? (value == null ? null : { value, label: "" });
  return (
    <PickerField {...{ id, label, className, style }}>
      <Combobox<Option> items={groups} value={selected} disabled={disabled} readOnly={readOnly}
        open={open} openOnInputClick inputValue={query ?? selected?.label ?? ""}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery(null);
        }}
        isItemEqualToValue={(a, b) => a.value === b.value}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change") {
            const type = (details.event as InputEvent).inputType;
            if (replayingOtherField.current && (type === "historyUndo" || type === "historyRedo")) {
              details.cancel();
              return;
            }
            setQuery(next);
            setOpen(true);
          } else if (details.reason === "clear-press") {
            setQuery(null);
          }
        }}
        onValueChange={(next, details) => {
          if (details.reason === "escape-key") {
            details.cancel();
            if (!open) details.allowPropagation();
          } else if (details.reason === "input-clear") {
            details.cancel();
          } else if (next?.value !== value) {
            onChange?.(next?.value ?? null);
          }
        }}>
        <ComboboxInputGroup ref={anchor} className="tm-field-control tm-combobox-field">
          <ComboboxInput ref={setInput} id={id} aria-label={ariaLabel} placeholder={placeholder} onFocus={() => {
            if (!readOnly && !disabled && !replayingOtherField.current) setOpen(true);
          }} />
          {clearable && selected && !disabled && !readOnly ? (
            <ComboboxClear aria-label={clearLabel ?? t("清除", "Clear")} />
          ) : <ComboboxTrigger aria-label={ariaLabel ?? label} />}
        </ComboboxInputGroup>
        <ComboOptions {...{ anchor, renderOption, nothingFoundMessage }} label={ariaLabel ?? label} />
      </Combobox>
    </PickerField>
  );
}

function SearchChip({ label, removeLabel, revealLabel }: {
  label: string;
  removeLabel?: string;
  revealLabel?: boolean;
}) {
  const text = useRef<HTMLSpanElement>(null);
  const chip = <ComboboxChip removeLabel={removeLabel}>
    <span ref={text} data-slot="picker-chip-label">{label}</span>
  </ComboboxChip>;
  if (!revealLabel) return chip;

  return (
    <Tooltip onOpenChange={(open, details) => {
      const element = text.current;
      if (open && (!element || element.scrollWidth <= element.clientWidth)) details.cancel();
    }}>
      <TooltipTrigger render={chip} />
      <TooltipContent aria-hidden="true">{label}</TooltipContent>
    </Tooltip>
  );
}

export function SearchMultiPicker({
  options, value, onChange, label, "aria-label": ariaLabel, className, style, disabled, placeholder,
  clearable, maxValues = Infinity, removeLabel, canRemove, revealLabels,
}: MultipleProps & { clearable?: boolean; revealLabels?: boolean }) {
  const id = useId();
  const t = useCopy();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupsFor(options), [options]);
  const items = groups.flatMap((group) => group.items);
  const known = useSelectedOptions(items, value);
  const selected = value.map(key => known.find(item => item.value === key) ?? { value: key, label: key });
  return (
    <PickerField {...{ id, label, className, style }}>
      <Combobox<Option, true> multiple items={groups} value={selected} disabled={disabled}
        open={open} openOnInputClick inputValue={query}
        onInputValueChange={(next, details) => { if (details.reason !== "escape-key" || open) setQuery(next); }}
        onOpenChange={(next, details) => {
          if (details.reason === "item-press") details.cancel();
          else setOpen(next);
        }}
        isItemEqualToValue={(a, b) => a.value === b.value}
        onValueChange={(next, details) => {
          if (details.reason === "escape-key") {
            details.cancel();
            if (!open) details.allowPropagation();
            return;
          }
          if (details.reason === "item-press") setQuery("");
          if (next.length > maxValues ||
              selected.some((item) => canRemove?.(item) === false && !next.some((other) => other.value === item.value))) {
            details.cancel();
            return;
          }
          onChange(next.map((item) => item.value));
        }}>
        <ComboboxChips ref={anchor} className="tm-field-control tm-combobox-field tm-picker-chips"
          data-disabled={disabled || undefined} data-reveal-labels={revealLabels || undefined}>
          <div className="tm-picker-chip-area">
            {selected.map((option) => (
              <SearchChip key={option.value} label={option.label} revealLabel={revealLabels}
                removeLabel={canRemove?.(option) === false ? undefined : removeLabel?.(option) ?? t("移除 ", "Remove ") + option.label} />
            ))}
            <ComboboxInput id={id} aria-label={ariaLabel} placeholder={placeholder} onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Backspace" && isImeComposing(event)) event.preventBaseUIHandler();
              }} />
          </div>
          {clearable && selected.length > 0 && !disabled ? <ComboboxClear aria-label={t("清除", "Clear")} />
            : <ComboboxTrigger aria-label={ariaLabel ?? label} />}
        </ComboboxChips>
        <ComboOptions anchor={anchor} label={ariaLabel ?? label} />
      </Combobox>
    </PickerField>
  );
}

export function MultiPicker({
  options, value, onChange, label, "aria-label": ariaLabel, className, style,
  disabled, readOnly, placeholder, maxValues = Infinity, removeLabel, optionName,
}: MultipleProps) {
  const id = useId();
  const t = useCopy();
  const container = useContext(OverlayPopupContainer);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => groupsFor(options), [options]);
  const items = groups.flatMap((group) => group.items);
  const known = useSelectedOptions(items, value);
  const selected = value.map(key => known.find(item => item.value === key) ?? { value: key, label: key });
  function remove(key: string) {
    trigger.current?.focus({ preventScroll: true });
    onChange(value.filter((item) => item !== key));
  }
  return (
    <PickerField {...{ id, label, className, style }}>
      <Select<string, true> multiple items={items} value={value} disabled={disabled} readOnly={readOnly} modal={false}
        onValueChange={(next, details) => {
          if (next.length > maxValues) details.cancel();
          else onChange(next);
        }}>
        <div ref={anchor} className="tm-field-control tm-picker-chips tm-multi-select" data-disabled={disabled || undefined}>
          <div className="tm-picker-chip-area">
            {selected.map((option) => (
              <div key={option.value} data-slot="picker-chip" className="tm-picker-chip">
                <span data-slot="picker-chip-label">{option.label}</span>
                {!readOnly && <button type="button" tabIndex={-1} className="tm-picker-remove" disabled={disabled}
                  aria-label={removeLabel?.(option) ?? t("移除 ", "Remove ") + option.label}
                  onClick={() => remove(option.value)}><X size={16} aria-hidden="true" /></button>}
              </div>
            ))}
          </div>
          <SelectTrigger ref={trigger} id={id} aria-label={ariaLabel} data-placeholder={!selected.length || undefined}
            onKeyDown={(event) => {
              if (!readOnly && event.key === "Backspace" && selected.length) {
                event.preventDefault();
                remove(selected[selected.length - 1].value);
              }
            }}>{selected.length ? null : placeholder}</SelectTrigger>
        </div>
        <SelectContent anchor={anchor} container={container} aria-label={ariaLabel ?? label}><SelectOptions groups={groups} optionName={optionName} /></SelectContent>
      </Select>
    </PickerField>
  );
}

export function NativePicker({
  options, label, "aria-label": ariaLabel, className, style, disabled, value, onChange,
}: FieldProps & { value: string; onChange: ChangeEventHandler<HTMLSelectElement> }) {
  const id = useId();
  const groups = useMemo(() => groupsFor(options), [options]);
  return (
    <PickerField {...{ id, label, className, style }}>
      <NativeSelect id={id} aria-label={ariaLabel} value={value} disabled={disabled} onChange={onChange}>
        {groups.flatMap(({ items }) => items.map((item) => (
          <NativeSelectOption key={item.value} value={item.value} disabled={item.disabled}>{item.label}</NativeSelectOption>
        )))}
      </NativeSelect>
    </PickerField>
  );
}
