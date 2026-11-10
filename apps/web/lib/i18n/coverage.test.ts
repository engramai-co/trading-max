/**
 * Guards the bilingual contract.
 *
 * Chinese copy is allowed in the following shapes:
 *   - the message catalogue itself,
 *   - `<Localized zh=... en=...>` blocks for rich text,
 *   - the Chinese branch of a bilingual `zh ? ... : ...` or `locale === "zh" ? ... : ...` ternary,
 *   - bilingual string-pair arrays (`["中文", "English"]` or extended rows).
 *
 * Anything else means a string would render as Chinese even when the user has
 * selected English, so this test fails and points at the file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const HANZI = /[\u4e00-\u9fff]/;

function walk(directory: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) {
      continue;
    }
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) {
      entries.push(full);
    }
  }
  return entries;
}

/** Replace a match with blanks while preserving line structure. */
const KEEP_NEWLINES = (match: string) => match.replace(/[^\n]/g, " ");

function isQuote(ch: string) {
  return ch === '"' || ch === "'" || ch === "`";
}

/** Split an array body on top-level commas, keeping strings intact. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (isQuote(ch)) {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < body.length) {
        current += body[i];
        if (body[i] === "\\") {
          i += 1;
          if (i < body.length) current += body[i];
          i += 1;
          continue;
        }
        i += 1;
        if (body[i - 1] === quote) break;
      }
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * True when the array body is a mixed-language string list (every element is
 * a string literal, and at least one entry contains Hanzi while another
 * contains none). A Chinese-only array is not a translation pair and is
 * therefore still reported.
 */
function isMixedBilingualPair(body: string): boolean {
  const elements = splitTopLevel(body)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (elements.length < 2) return false;
  const values = elements.map((part) => {
    const match = /^(["'`])([\s\S]*)\1$/.exec(part);
    return match ? match[2] : null;
  });
  if (values.some((value) => value === null)) return false;
  const texts = values as string[];
  return (
    texts.some((value) => HANZI.test(value)) &&
    texts.some((value) => !HANZI.test(value))
  );
}

/** Blank out mixed `["中文", "English"]` arrays, including multi-line ones. */
function stripMixedArrays(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (isQuote(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        j += 1;
        if (source[j - 1] === quote) break;
      }
      out.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (ch !== "[") {
      out.push(ch);
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < source.length && depth > 0) {
      if (isQuote(source[j])) {
        const quote = source[j];
        j += 1;
        while (j < source.length) {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          j += 1;
          if (source[j - 1] === quote) break;
        }
        continue;
      }
      if (source[j] === "[") depth += 1;
      if (source[j] === "]") depth -= 1;
      j += 1;
    }
    const body = source.slice(i + 1, j - 1);
    if (isMixedBilingualPair(body)) {
      out.push(KEEP_NEWLINES(body));
    } else {
      out.push("[", stripMixedArrays(body), "]");
    }
    i = j;
  }
  return out.join("");
}

function isChineseCondition(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "zh") ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "locale" &&
      ts.isStringLiteral(node.right) &&
      node.right.text === "zh")
  );
}

function isCopyString(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);
}

/** Strip the constructs that are allowed to carry Chinese. */
function stripAllowed(source: string): string {
  const parsed = ts.createSourceFile(
    "copy.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const spans: Array<[number, number]> = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === "t" &&
      node.arguments.length === 2 &&
      node.arguments.every(ts.isStringLiteral)
    ) {
      const [zh, en] = node.arguments as unknown as [
        ts.StringLiteral,
        ts.StringLiteral,
      ];
      if (zh.text.trim() && en.text.trim() && !HANZI.test(en.text)) {
        spans.push([node.getStart(parsed), node.end]);
        return;
      }
    }
    if (
      ts.isConditionalExpression(node) &&
      isChineseCondition(node.condition) &&
      ((isCopyString(node.whenTrue) && isCopyString(node.whenFalse)) ||
        (ts.isObjectLiteralExpression(node.whenTrue) &&
          ts.isObjectLiteralExpression(node.whenFalse)))
    ) {
      // Keep the English branch in the scan, even for templates and copy objects.
      spans.push([node.whenTrue.getStart(parsed), node.whenTrue.end]);
      visit(node.whenFalse);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  let s = source;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0]))
    s = s.slice(0, start) + KEEP_NEWLINES(s.slice(start, end)) + s.slice(end);
  // Comments are never UI copy; keep line structure for clear reports.
  s = s.replace(/\/\*[\s\S]*?\*\//g, KEEP_NEWLINES);
  s = s.replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  // Language controls name the target language in that language, even in English.
  s = s.replace(/中\s*文\s*<\/button>/g, "</button>");
  s = s.replace(
    /\{\s*value:\s*"zh"\s+as\s+const,\s*label:\s*"中文",\s*lang:\s*"zh-CN",\s*action:\s*"切换到中文"\s*\}/g,
    KEEP_NEWLINES,
  );
  // <Localized zh="..." en="..." /> and multi-line variants
  s = s.replace(/<Localized\b[\s\S]*?\/>/g, KEEP_NEWLINES);
  s = s.replace(/<Localized\b[\s\S]*?<\/Localized\s*>/g, KEEP_NEWLINES);
  // zh= / zh: entries inside localized objects and props
  s = s.replace(
    /\bzh\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/g,
    KEEP_NEWLINES,
  );
  s = s.replace(/\bzh\s*=\s*\{[\s\S]*?\}/g, KEEP_NEWLINES);
  // statusCopy = { zh: { ... }, en: { ... } } paired objects
  s = s.replace(
    /\bzh\s*:\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*,?\s*en\s*:\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    KEEP_NEWLINES,
  );
  // ["中文", "English"] mixed-language translation arrays.
  return stripMixedArrays(s);
}

describe("bilingual coverage", () => {
  const files = walk(path.join(WEB_ROOT, "components")).concat(
    walk(path.join(WEB_ROOT, "app")),
    walk(path.join(WEB_ROOT, "workspace")),
    walk(path.join(WEB_ROOT, "lib")).filter(
      (file) => !file.includes(path.join("lib", "i18n")),
    ),
  );

  it("accepts formatted bilingual calls while rejecting missing translations", () => {
    expect(HANZI.test(stripAllowed('t(\n"中文",\n"English",\n)'))).toBe(false);
    expect(HANZI.test(stripAllowed('t("中文", "还是中文")'))).toBe(true);
    expect(HANZI.test(stripAllowed('t("中文")'))).toBe(true);
  });

  it.each([
    ['zh ? "中文" : "English"', 'zh ? "中文" : "还是中文"'],
    [
      'locale === "zh" ? `共 ${count} 项` : `${count} items`',
      'locale === "zh" ? `共 ${count} 项` : `${count} 项`',
    ],
    [
      'locale === "zh" ? { label: "中文" } : { label: "English" }',
      'locale === "zh" ? { label: "中文" } : { label: "还是中文" }',
    ],
  ])("checks the English branch of %s", (translated, untranslated) => {
    expect(HANZI.test(stripAllowed(translated))).toBe(false);
    expect(HANZI.test(stripAllowed(untranslated))).toBe(true);
  });

  it("scans the whole frontend", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("keeps Chinese copy inside the localisation constructs", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const stripped = stripAllowed(readFileSync(file, "utf8"));
      for (const [index, line] of stripped.split("\n").entries()) {
        if (HANZI.test(line)) {
          offenders.push(
            `${path.relative(WEB_ROOT, file)}:${index + 1} ${line.trim().slice(0, 80)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `untranslatable Chinese copy:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
