import { createElement as el } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { numericFormatter, removeNumericFormat, type NumericFormatProps } from "react-number-format";
import {
  NumericInput,
  normalizeNumericText,
  numericChangeValue,
  stepNumericValue,
} from "./numeric-input";

type ParityRow = {
  input: string;
  normalized: string;
  paste: number | string;
  pasteFormatted: string;
  type: number | string;
};

/**
 * Expected outputs from the previous Mantine 9.8.0 NumberInput (normalizePastedValue +
 * react-number-format) with each call site's exact props from HEAD, where thousandSeparator
 * was left unset (undefined).
 */
const OPTION_FEE_PARITY: ParityRow[] = [
  { input: "1,25", normalized: "1.25", paste: 1.25, pasteFormatted: "1.25", type: 1.25 },
  { input: "1,234", normalized: "1.234", paste: 1.234, pasteFormatted: "1.234", type: 1.234 },
  { input: "£1,234", normalized: "£1.234", paste: 1.234, pasteFormatted: "1.234", type: 1.234 },
  { input: "1 234,567", normalized: "1 234.567", paste: 1234.567, pasteFormatted: "1234.567", type: 1234.567 },
  { input: "1,234.56", normalized: "1234.56", paste: 1234.56, pasteFormatted: "1234.56", type: 1.23456 },
  { input: "1.234,56", normalized: "1234.56", paste: 1234.56, pasteFormatted: "1234.56", type: 1.23456 },
  { input: "-1,5", normalized: "-1.5", paste: -1.5, pasteFormatted: "-1.5", type: -1.5 },
  { input: "", normalized: "", paste: "", pasteFormatted: "", type: "" },
  { input: "abc", normalized: "abc", paste: "", pasteFormatted: "", type: "" },
  { input: "12.", normalized: "12.", paste: "12.", pasteFormatted: "12.", type: "12." },
  { input: " 1 234 ", normalized: " 1 234 ", paste: 1234, pasteFormatted: "1234", type: 1234 },
  { input: " 1,234 ", normalized: " 1.234 ", paste: 1.234, pasteFormatted: "1.234", type: 1.234 },
  { input: "1 234.56", normalized: "1 234.56", paste: 1234.56, pasteFormatted: "1234.56", type: 1234.56 },
  { input: " 1 234,56 ", normalized: " 1 234.56 ", paste: 1234.56, pasteFormatted: "1234.56", type: 1234.56 },
  { input: "   ", normalized: "   ", paste: "", pasteFormatted: "", type: "" },
  { input: "- 1,5", normalized: "- 1.5", paste: -1.5, pasteFormatted: "-1.5", type: -1.5 },
  { input: " -1,5 ", normalized: " -1.5 ", paste: -1.5, pasteFormatted: "-1.5", type: -1.5 },
  { input: "1,234,567", normalized: "1234567", paste: 1234567, pasteFormatted: "1234567", type: 1.234567 },
  { input: "1.234.567,89", normalized: "1234567.89", paste: 1234567.89, pasteFormatted: "1234567.89", type: 1.23456789 },
  { input: "1,234,567.89", normalized: "1234567.89", paste: 1234567.89, pasteFormatted: "1234567.89", type: 1.23456789 },
  { input: "0,125", normalized: "0.125", paste: 0.125, pasteFormatted: "0.125", type: 0.125 },
  { input: "-0,25", normalized: "-0.25", paste: -0.25, pasteFormatted: "-0.25", type: -0.25 },
  { input: "12,", normalized: "12.", paste: "12.", pasteFormatted: "12.", type: "12." },
  { input: ",5", normalized: ".5", paste: 0.5, pasteFormatted: ".5", type: 0.5 },
];

const VALUATION_PERCENT_PARITY: ParityRow[] = [
  { input: "1,25", normalized: "1.25", paste: 1.25, pasteFormatted: "1.25%", type: 1.25 },
  { input: "1,234", normalized: "1.234", paste: 1.23, pasteFormatted: "1.23%", type: 1.23 },
  { input: "£1,234", normalized: "£1.234", paste: 1.23, pasteFormatted: "1.23%", type: 1.23 },
  { input: "1 234,567", normalized: "1 234.567", paste: 1234.56, pasteFormatted: "1234.56%", type: 1234.56 },
  { input: "1,234.56", normalized: "1234.56", paste: 1234.56, pasteFormatted: "1234.56%", type: 1.23 },
  { input: "1.234,56", normalized: "1234.56", paste: 1234.56, pasteFormatted: "1234.56%", type: 1.23 },
  { input: "-1,5", normalized: "-1.5", paste: -1.5, pasteFormatted: "-1.5%", type: -1.5 },
  { input: "", normalized: "", paste: "", pasteFormatted: "", type: "" },
  { input: "abc", normalized: "abc", paste: "", pasteFormatted: "", type: "" },
  { input: "12.", normalized: "12.", paste: "12.", pasteFormatted: "12.%", type: "12." },
  { input: " 1 234 ", normalized: " 1 234 ", paste: 1234, pasteFormatted: "1234%", type: 1234 },
  { input: " 1,234 ", normalized: " 1.234 ", paste: 1.23, pasteFormatted: "1.23%", type: 1.23 },
  { input: "1 234.56", normalized: "1 234.56", paste: 1234.56, pasteFormatted: "1234.56%", type: 1234.56 },
];

const INTEGER_EDITOR_PARITY: ParityRow[] = [
  { input: "1,25", normalized: "1.25", paste: 1, pasteFormatted: "1", type: 125 },
  { input: "1,234", normalized: "1.234", paste: 1, pasteFormatted: "1", type: 1234 },
  { input: "£1,234", normalized: "£1.234", paste: 1, pasteFormatted: "1", type: 1234 },
  { input: "1 234,567", normalized: "1 234.567", paste: 1234, pasteFormatted: "1234", type: 1234567 },
  { input: "1,234.56", normalized: "1234.56", paste: 1234, pasteFormatted: "1234", type: 123456 },
  { input: "1.234,56", normalized: "1234.56", paste: 1234, pasteFormatted: "1234", type: 123456 },
  { input: "-1,5", normalized: "-1.5", paste: -1, pasteFormatted: "-1", type: -15 },
  { input: "", normalized: "", paste: "", pasteFormatted: "", type: "" },
  { input: "abc", normalized: "abc", paste: "", pasteFormatted: "", type: "" },
  { input: "12.", normalized: "12.", paste: 12, pasteFormatted: "12", type: 12 },
  { input: " 1 234 ", normalized: " 1 234 ", paste: 1234, pasteFormatted: "1234", type: 1234 },
  { input: " 1,234 ", normalized: " 1.234 ", paste: 1, pasteFormatted: "1", type: 1234 },
  { input: "-0,25", normalized: "-0.25", paste: "-0", pasteFormatted: "-0", type: "-025" },
];

function parseNumericText(input: string, { mode, ...props }: NumericFormatProps & { mode: "paste" | "type" }) {
  const options = { allowNegative: true, allowedDecimalSeparators: [".", ","], ...props };
  const normalized = mode === "paste" ? normalizeNumericText(input, options) : input;
  let formattedValue = "";
  const insert = (text: string) => {
    const start = options.suffix && formattedValue.endsWith(options.suffix)
      ? formattedValue.length - options.suffix.length
      : formattedValue.length;
    const next = formattedValue.slice(0, start) + text + formattedValue.slice(start);
    const raw = removeNumericFormat(next, {
      from: { start, end: start },
      to: { start, end: start + text.length },
      lastValue: formattedValue,
    }, options);
    formattedValue = numericFormatter(raw, options);
  };
  if (mode === "paste") insert(normalized);
  else for (const character of input) insert(character);
  const value = removeNumericFormat(formattedValue, {
    from: { start: 0, end: 0 },
    to: { start: 0, end: formattedValue.length },
    lastValue: "",
  }, options);
  const floatValue = parseFloat(value);
  return { normalized, formattedValue, emittedValue: numericChangeValue(value, floatValue) };
}

describe("Mantine NumberInput parity", () => {
  it.each(OPTION_FEE_PARITY)(
    "matches Mantine option fee/premium editor for $input",
    ({ input, normalized, paste, pasteFormatted, type }) => {
      expect(normalizeNumericText(input)).toBe(normalized);
      const pasted = parseNumericText(input, { mode: "paste" });
      expect(pasted.normalized).toBe(normalized);
      expect(pasted.emittedValue).toEqual(paste);
      expect(pasted.formattedValue).toBe(pasteFormatted);

      const typed = parseNumericText(input, { mode: "type" });
      expect(typed.emittedValue).toEqual(type);
    },
  );

  it.each(VALUATION_PERCENT_PARITY)(
    "matches Mantine valuation assumption editor (decimalScale=2, suffix=%) for $input",
    ({ input, normalized, paste, pasteFormatted, type }) => {
      const options: NumericFormatProps = { decimalScale: 2, suffix: "%" };
      const pasted = parseNumericText(input, { ...options, mode: "paste" });
      expect(pasted.normalized).toBe(normalized);
      expect(pasted.emittedValue).toEqual(paste);
      expect(pasted.formattedValue).toBe(pasteFormatted);

      const typed = parseNumericText(input, { ...options, mode: "type" });
      expect(typed.emittedValue).toEqual(type);
    },
  );

  it("matches Mantine valuation multiple editor (decimalScale=2, suffix=×)", () => {
    expect(parseNumericText("1,234", { decimalScale: 2, suffix: "×", mode: "paste" })).toMatchObject({
      emittedValue: 1.23,
      formattedValue: "1.23×",
    });
    expect(parseNumericText("1 234,567", { decimalScale: 2, suffix: "×", mode: "paste" })).toMatchObject({
      emittedValue: 1234.56,
      formattedValue: "1234.56×",
    });
  });

  it.each(INTEGER_EDITOR_PARITY)(
    "matches Mantine integer editor (option quantity / rampYears, decimalScale=0) for $input",
    ({ input, normalized, paste, pasteFormatted, type }) => {
      const options: NumericFormatProps = { decimalScale: 0 };
      const pasted = parseNumericText(input, { ...options, mode: "paste" });
      expect(pasted.normalized).toBe(normalized);
      expect(pasted.emittedValue).toEqual(paste);
      expect(pasted.formattedValue).toBe(pasteFormatted);

      const typed = parseNumericText(input, { ...options, mode: "type" });
      expect(typed.emittedValue).toEqual(type);
    },
  );

  it.each<{
    name: string;
    options: NumericFormatProps;
    input: string;
    expected: number | string;
    formatted: string;
  }>([
    { name: "explicit thousandSeparator=',' parses 1,234 as 1234", options: { thousandSeparator: "," }, input: "1,234", expected: 1234, formatted: "1,234" },
    { name: "explicit thousandSeparator=',' parses £1,234 as 1234", options: { thousandSeparator: "," }, input: "£1,234", expected: 1234, formatted: "1,234" },
    { name: "explicit thousandSeparator=',' parses 1 234,567 as 1234567", options: { thousandSeparator: "," }, input: "1 234,567", expected: 1234567, formatted: "1,234,567" },
    { name: "explicit thousandSeparator=',' parses 1,25 as 1.25", options: { thousandSeparator: "," }, input: "1,25", expected: 1.25, formatted: "1.25" },
    { name: "allowNegative=false strips minus on -1,5", options: { allowNegative: false }, input: "-1,5", expected: 1.5, formatted: "1.5" },
    { name: "prefix='£' keeps decimal comma on £1,234", options: { prefix: "£" }, input: "£1,234", expected: 1.234, formatted: "£1.234" },
    { name: "prefix='£' keeps the currency prefix on £1,234.56", options: { prefix: "£" }, input: "£1,234.56", expected: 1234.56, formatted: "£1234.56" },
    { name: "decimalSeparator=',' keeps 1,234 as 1.234 without separator collision", options: { decimalSeparator: "," }, input: "1,234", expected: 1.234, formatted: "1,234" },
    { name: "decimalSeparator=',' parses 1.234,56 as 1234.56", options: { decimalSeparator: "," }, input: "1.234,56", expected: 1234.56, formatted: "1234,56" },
    { name: "decimalSeparator=',' parses 1 234,567 as 1234.567", options: { decimalSeparator: "," }, input: "1 234,567", expected: 1234.567, formatted: "1234,567" },
  ])("$name", ({ options, input, expected, formatted }) => {
    const result = parseNumericText(input, { ...options, mode: "paste" });
    expect(result.emittedValue).toEqual(expected);
    expect(result.formattedValue).toBe(formatted);
  });
});

describe("numericChangeValue", () => {
  it.each([
    ["", ""],
    ["-", "-"],
    ["001", "001"],
    ["12.", "12."],
    ["1.20", "1.20"],
    ["0", 0],
    ["1.25", 1.25],
    ["1234567890123456", "1234567890123456"],
  ])("emits the Mantine value type for '%s'", (raw, expected) => {
    expect(numericChangeValue(raw, parseFloat(raw))).toBe(expected);
  });
});

describe("stepNumericValue", () => {
  it("uses exact safe-integer arithmetic in both directions on 16-digit safe integers", () => {
    expect(stepNumericValue(1234567890123456, 1)).toBe(1234567890123457);
    expect(stepNumericValue(1234567890123456, -1)).toBe(1234567890123455);
    expect(stepNumericValue("1234567890123456", 1)).toBe(1234567890123457);
    expect(stepNumericValue("1234567890123456", -1)).toBe(1234567890123455);
    expect(stepNumericValue(-1234567890123456, 1)).toBe(-1234567890123455);
    expect(stepNumericValue(-1234567890123456, -1)).toBe(-1234567890123457);
    expect(stepNumericValue(Number.MAX_SAFE_INTEGER, -1)).toBe(9007199254740990);
    expect(stepNumericValue(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(stepNumericValue(Number.MIN_SAFE_INTEGER, 1)).toBe(-9007199254740990);
    expect(stepNumericValue(Number.MIN_SAFE_INTEGER, -1)).toBeNull();
  });

  it("rounds fractional steps by the value and step decimal places without float drift", () => {
    expect(stepNumericValue(0.1, 1, { step: 0.2 })).toBe(0.3);
    expect(stepNumericValue(0.3, -1, { step: 0.1 })).toBe(0.2);
    expect(stepNumericValue(1.25, 1, { step: 0.5 })).toBe(1.75);
    expect(stepNumericValue(1.25, -1, { step: 0.5 })).toBe(0.75);
    expect(stepNumericValue(1.2, 1, { step: 1 })).toBe(2.2);
    expect(stepNumericValue(1.2, -1, { step: 1 })).toBe(0.2);
    expect(Object.is(stepNumericValue(0.5, -1, { step: 0.5 }), 0)).toBe(true);
    expect(Object.is(stepNumericValue(-0.1, 1, { step: 0.1 }), 0)).toBe(true);
    expect(stepNumericValue(1.005, 1, { step: 0.001 })).toBe(1.006);
    expect(stepNumericValue(1.005, -1, { step: 0.001 })).toBe(1.004);
  });

  it("clamps empty, invalid, and out-of-range steps", () => {
    expect(stepNumericValue("", 1, { min: 0 })).toBe(0);
    expect(stepNumericValue("", -1, { min: 5, max: 10 })).toBe(5);
    expect(stepNumericValue("-", 1, { min: -10, max: 10 })).toBe(0);
    expect(stepNumericValue(0, -1, { min: 0 })).toBe(0);
    expect(stepNumericValue(99.5, 1, { step: 1, max: 100 })).toBe(100);
  });
});

describe("NumericInput rendering", () => {
  it("keeps grouping opt-in and formats negative decimals, suffixes, decimalSeparator=',', and empty values", () => {
    expect(renderToStaticMarkup(el(NumericInput, { value: 1234.56, onChange: () => {} }))).toContain('value="1234.56"');
    expect(renderToStaticMarkup(el(NumericInput, { value: 1234.56, thousandSeparator: true, onChange: () => {} }))).toContain('value="1,234.56"');
    expect(renderToStaticMarkup(el(NumericInput, { value: 1234.56, decimalSeparator: ",", onChange: () => {} }))).toContain('value="1234,56"');
    expect(renderToStaticMarkup(el(NumericInput, { value: -1.25, onChange: () => {} }))).toContain('value="-1.25"');
    expect(renderToStaticMarkup(el(NumericInput, { value: 1.25, suffix: "%", onChange: () => {} }))).toContain('value="1.25%"');
    expect(renderToStaticMarkup(el(NumericInput, { value: "", onChange: () => {} }))).toContain('value=""');
  });
});
