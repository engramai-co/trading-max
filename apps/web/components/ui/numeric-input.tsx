"use client";

import { useLayoutEffect, useRef } from "react";
import { NumericFormat, type NumericFormatProps } from "react-number-format";
import { isImeComposing } from "@/workspace/shortcut-platform";
import { Input } from "./input";

const DEFAULT_ALLOWED_DECIMAL_SEPARATORS = [".", ","];

type NumericSeparatorOptions = Pick<
  NumericFormatProps,
  "decimalSeparator" | "thousandSeparator" | "allowedDecimalSeparators" | "thousandsGroupStyle"
>;

function resolveThousandSeparator(separator: string | boolean | undefined): string | undefined {
  return separator === true ? "," : separator === false ? undefined : separator;
}

function countTrailingDigits(value: string, from: number): number {
  let count = 0;
  while (from + count < value.length && /\d/.test(value[from + count])) count += 1;
  return count;
}

/**
 * Normalises clipboard text using the same separator rules as
 * Mantine's NumberInput: when thousandSeparator is unset, a single comma is a decimal
 * separator ("1,234" -> "1.234", "1 234,567" -> "1 234.567").
 */
export function normalizeNumericText(
  value: string,
  {
    decimalSeparator = ".",
    thousandSeparator,
    allowedDecimalSeparators = DEFAULT_ALLOWED_DECIMAL_SEPARATORS,
    thousandsGroupStyle,
  }: NumericSeparatorOptions = {},
): string {
  const resolvedThousand = resolveThousandSeparator(thousandSeparator);
  const candidates = new Set(
    [...allowedDecimalSeparators, decimalSeparator].filter((separator) => separator.length === 1),
  );
  const chars = value.split("");
  const occurrences: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (candidates.has(chars[index])) occurrences.push(index);
  }
  if (occurrences.length === 0) return value;

  const lastIndex = occurrences[occurrences.length - 1];
  const lastChar = chars[lastIndex];
  const lastCharCount = occurrences.filter((index) => chars[index] === lastChar).length;
  const lastGroupSize = thousandsGroupStyle === "wan" ? 4 : 3;

  let decimalIndex = -1;
  if (lastCharCount === 1) {
    if (lastChar === decimalSeparator) {
      decimalIndex = lastIndex;
    } else if (lastChar === resolvedThousand) {
      decimalIndex = countTrailingDigits(value, lastIndex + 1) === lastGroupSize ? -1 : lastIndex;
    } else {
      decimalIndex = lastIndex;
    }
  }

  return chars
    .map((char, index) => {
      if (index === decimalIndex) return decimalSeparator;
      if (candidates.has(char) && char !== resolvedThousand) return "";
      return char;
    })
    .join("");
}

export function numericChangeValue(raw: string, floatValue: number | undefined): number | string {
  const preserveDraft = /^(?:-?0\.0*|-0|-?0\d+(?:\.\d+)?\.?)$|\.\d*0$|^-?\d+\.$/.test(raw);
  return floatValue !== undefined &&
    Number.isFinite(floatValue) &&
    floatValue < Number.MAX_SAFE_INTEGER &&
    raw.replace(".", "").length < 14 &&
    !preserveDraft
    ? floatValue
    : raw;
}

function decimalPlaces(input: number | string): number {
  const match = String(input).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return 0;
  return Math.max(0, (match[1]?.length ?? 0) - (match[2] ? Number(match[2]) : 0));
}

/**
 * Steps a numeric value by one increment using exact safe-integer arithmetic for integers
 * and decimal-place rounding for fractional steps, without corrupting 16-digit safe integers.
 */
export function stepNumericValue(
  value: number | string,
  direction: 1 | -1,
  { step = 1, min = -Infinity, max = Infinity }: { step?: number; min?: number; max?: number } = {},
): number | null {
  const clamp = (number: number) => {
    const clamped = Math.min(max, Math.max(min, number));
    return Object.is(clamped, -0) ? 0 : clamped;
  };
  if (value === "" || !Number.isFinite(Number(value))) {
    return clamp(0);
  }
  const current = Number(value);
  if (!Number.isFinite(current) || !Number.isFinite(step)) return null;

  if (Number.isInteger(current) && Number.isInteger(step)) {
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(step)) return null;
    const next = BigInt(current) + BigInt(direction) * BigInt(step);
    if (next > BigInt(Number.MAX_SAFE_INTEGER) || next < BigInt(Number.MIN_SAFE_INTEGER)) {
      return null;
    }
    return clamp(Number(next));
  }

  if (Math.abs(current) > Number.MAX_SAFE_INTEGER) return null;
  const precision = Math.max(decimalPlaces(current), decimalPlaces(step));
  const raw = current + direction * step;
  const rounded =
    precision > 0 && precision <= 20 && Math.abs(raw) < 1e21
      ? Number(raw.toFixed(precision))
      : raw;
  return clamp(rounded);
}

type NumericInputProps = Omit<
  NumericFormatProps,
  "customInput" | "getInputRef" | "onChange" | "onValueChange" | "value" | "min" | "max" | "step"
> & {
  value: number | string;
  onChange: (value: number | string) => void;
  min?: number;
  max?: number;
  step?: number;
};

export function NumericInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  readOnly,
  decimalScale,
  decimalSeparator = ".",
  thousandSeparator,
  allowedDecimalSeparators = DEFAULT_ALLOWED_DECIMAL_SEPARATORS,
  thousandsGroupStyle,
  allowNegative = true,
  onPaste,
  onBlur,
  onKeyDown,
  ...props
}: NumericInputProps) {
  const latestValue = useRef(value);
  useLayoutEffect(() => {
    latestValue.current = value;
  }, [value]);

  const updateValue = (next: number | string) => {
    latestValue.current = next;
    onChange(next);
  };

  return (
    <NumericFormat
      {...props}
      customInput={Input}
      value={value}
      valueIsNumericString
      decimalSeparator={decimalSeparator}
      thousandSeparator={thousandSeparator}
      thousandsGroupStyle={thousandsGroupStyle}
      allowedDecimalSeparators={allowedDecimalSeparators}
      inputMode="decimal"
      decimalScale={decimalScale}
      allowLeadingZeros
      allowNegative={allowNegative}
      readOnly={readOnly}
      onValueChange={(values, source) => {
        if (source.source === "event") updateValue(numericChangeValue(values.value, values.floatValue));
      }}
      onBlur={(event) => {
        const current = latestValue.current;
        const parsed = typeof current === "number" ? current : parseFloat(current);
        if (!readOnly && !Number.isNaN(parsed)) {
          const clamped = Math.min(max, Math.max(min, parsed));
          const next = typeof current === "string" && /^-?\d+\.$/.test(current) ? `${clamped}.` : clamped;
          if (next !== current && (parsed !== clamped || decimalPlaces(current) < 15)) updateValue(next);
        }
        onBlur?.(event);
      }}
      onPaste={(event) => {
        onPaste?.(event);
        if (readOnly || props.disabled || event.defaultPrevented) return;
        const pasted = event.clipboardData.getData("text");
        const normalized = normalizeNumericText(pasted, {
          decimalSeparator,
          thousandSeparator,
          allowedDecimalSeparators,
          thousandsGroupStyle,
        });
        if (normalized !== pasted) {
          // The native editing command keeps undo history and delivers the input to NumericFormat.
          event.preventDefault();
          event.currentTarget.ownerDocument.execCommand("insertText", false, normalized);
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (readOnly || event.defaultPrevented || isImeComposing(event)) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const direction = event.key === "ArrowUp" ? 1 : -1;
        const lowerBound = direction === -1 && !allowNegative ? Math.max(0, min) : min;
        const next = stepNumericValue(latestValue.current, direction, { step, min: lowerBound, max });
        if (next !== null) updateValue(next);
      }}
    />
  );
}
