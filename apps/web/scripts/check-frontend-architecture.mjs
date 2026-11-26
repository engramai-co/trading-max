import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = fileURLToPath(new URL("./legacy-ui-imports-baseline.json", import.meta.url));
const deferredStyles = ["app/desktop/desktop.css", "workspace/assistant/readings.css", "workspace/assistant/research.css"];
const themeStylesheet = "app/shadcn-theme.css";
const allowedCss = new Set(["app/globals.css", themeStylesheet, ...deferredStyles]);
// Authored styles live in ordered surface files that app/globals.css imports.
const stylesDirectory = "app/styles/";
const stylesheetLineBudget = 900;
const stylesheetLineLength = 160;
const rawColourAllowlist = new Set(["ui/theme.ts"]);
const serverMantineAllowlist = new Set(["app/layout.tsx", "ui/theme.ts"]);
// Playwright traces contain captured CSS/JS, not authored application code.
const generatedDirectories = new Set(["node_modules", ".next", ".run", "test-results", "playwright-report"]);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const expectedLayerOrder = "@layer theme, base, mantine, components, utilities;";
const expectedDarkVariant = '@custom-variant dark (&:where([data-mantine-color-scheme="dark"], [data-mantine-color-scheme="dark"] *));';
const requiredToolchainImports = [
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
  '@import "tw-animate-css";',
  '@import "shadcn/tailwind.css";',
  '@import "@mantine/core/styles.layer.css";',
  '@import "@mantine/notifications/styles.layer.css";',
];
const themeImport = '@import "./shadcn-theme.css";';
const sourceDirectives = [
  '@source "../{app,components,lib,ui,workspace}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";',
  '@source not "../**/*.{test,spec}.*";',
  '@source not "../**/{tests,__tests__,__mocks__}/**";',
];

function isLegacyUiSpecifier(specifier) {
  return specifier === "@phosphor-icons/react"
    || specifier.startsWith("@phosphor-icons/react/")
    || specifier.startsWith("@mantine/");
}

export function extractLegacyUiImports(filePath, source) {
  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const found = new Map();

  function record(specifier, symbol) {
    let symbols = found.get(specifier);
    if (!symbols) {
      symbols = new Set();
      found.set(specifier, symbols);
    }
    symbols.add(symbol);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isLegacyUiSpecifier(specifier)) {
        const clause = node.importClause;
        if (!clause) {
          record(specifier, "<side-effect>");
        } else {
          if (clause.name) record(specifier, "default");
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              record(specifier, "*");
            } else if (ts.isNamedImports(clause.namedBindings)) {
              const { elements } = clause.namedBindings;
              if (!clause.name && elements.length === 0) record(specifier, "<side-effect>");
              for (const element of elements) {
                record(specifier, element.propertyName?.text ?? element.name.text);
              }
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isLegacyUiSpecifier(specifier)) {
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          record(specifier, "<re-export:*>");
        } else if (ts.isNamedExports(node.exportClause)) {
          const { elements } = node.exportClause;
          if (elements.length === 0) record(specifier, "<re-export>");
          for (const element of elements) {
            const symbol = element.propertyName?.text ?? element.name.text;
            record(specifier, `<re-export:${symbol}>`);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (specifier && ts.isStringLiteralLike(specifier) && isLegacyUiSpecifier(specifier.text)) {
        record(specifier.text, "<import-equals>");
      }
    } else if (
      ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length >= 1
    ) {
      const argument = ts.skipParentheses(node.arguments[0]);
      const raw = ts.isTaggedTemplateExpression(argument) && ts.isPropertyAccessExpression(argument.tag)
        && ts.isIdentifier(argument.tag.expression) && argument.tag.expression.text === "String"
        && argument.tag.name.text === "raw";
      const specifier = raw ? argument.template : argument;
      const text = (part) => (raw ? part.rawText : undefined) ?? part.text;
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic" : "require";
      if (ts.isStringLiteralLike(specifier) && isLegacyUiSpecifier(text(specifier))) {
        record(text(specifier), `<${kind}>`);
      } else if (ts.isTemplateExpression(specifier)) {
        const head = text(specifier.head);
        const [span] = specifier.templateSpans;
        const value = ts.skipParentheses(span.expression);
        const mayBeEmpty = !ts.isStringLiteralLike(value) || value.text === "";
        if (/^@(?:mantine|phosphor-icons)\//.test(head)
          || (/^@(?:mantine|phosphor-icons)$/.test(head) && text(span.literal).startsWith("/") && mayBeEmpty)) {
          record(head, `<${kind}-template>`);
        }
      }
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)
      && isLegacyUiSpecifier(node.argument.literal.text)
    ) {
      record(node.argument.literal.text, "<type-import>");
    }
    ts.forEachChild(node, visit);
  }

  visit(tree);

  const result = {};
  for (const specifier of [...found.keys()].sort()) {
    result[specifier] = [...found.get(specifier)].sort();
  }
  return result;
}

export function checkLegacyUiImports(actualByFile, baselineFiles, { writeBaseline = false } = {}) {
  const issues = [];
  for (const filePath of Object.keys(actualByFile).sort()) {
    const actualSpecifiers = actualByFile[filePath];
    const allowedSpecifiers = baselineFiles[filePath];
    if (!allowedSpecifiers) {
      const pkgs = Object.keys(actualSpecifiers).sort().join(", ");
      issues.push(`File outside legacy UI baseline may not import ${pkgs}: ${filePath}`);
      continue;
    }
    for (const specifier of Object.keys(actualSpecifiers).sort()) {
      const allowedSymbols = allowedSpecifiers[specifier];
      if (!allowedSymbols) {
        issues.push(`Existing file may not add legacy UI package ${specifier}: ${filePath}`);
        continue;
      }
      const allowedSet = new Set(allowedSymbols);
      const added = actualSpecifiers[specifier].filter((symbol) => !allowedSet.has(symbol));
      if (added.length) {
        issues.push(`Existing file may not add legacy UI imports from ${specifier} (${added.join(", ")}): ${filePath}`);
      }
    }
  }
  if (!writeBaseline) {
    const removed = Object.keys(baselineFiles).sort().filter((filePath) => (
      Object.entries(baselineFiles[filePath]).some(([specifier, symbols]) => (
        symbols.some((symbol) => !actualByFile[filePath]?.[specifier]?.includes(symbol))
      ))
    ));
    if (removed.length) {
      issues.push(
        "Legacy UI imports were removed. Run node scripts/check-frontend-architecture.mjs --write-baseline "
        + `from apps/web to shrink the baseline: ${removed.join(", ")}`,
      );
    }
  }
  return issues;
}

export function validateGlobalsManifest(globalsSource, styleFiles, hasThemeStylesheet = false) {
  const issues = [];
  const lines = globalsSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("/*"));

  if (lines[0] !== expectedLayerOrder) {
    issues.push(`app/globals.css must start with "${expectedLayerOrder}"`);
  }
  if (lines.some((line) => /@import\s+["']tailwindcss(?:\/preflight(?:\.css)?)?["']/.test(line))) {
    issues.push("app/globals.css must not import Tailwind preflight during migration");
  }

  const toolchainImports = [...requiredToolchainImports];
  if (hasThemeStylesheet) {
    toolchainImports.splice(toolchainImports.indexOf('@import "shadcn/tailwind.css";') + 1, 0, themeImport);
  }
  const firstStyle = toolchainImports.length + 1;
  if (toolchainImports.some((required, i) => lines[i + 1] !== required)) {
    issues.push("app/globals.css must import the Tailwind, shadcn and layered Mantine files in order");
  }
  if (lines.at(-1) !== expectedDarkVariant) {
    issues.push(`app/globals.css must end with dark variant: ${expectedDarkVariant}`);
  }

  const expected = styleFiles.map((path) => path.slice("app/".length));
  const firstSource = lines.length - sourceDirectives.length - 1;
  if (sourceDirectives.some((directive, i) => lines[firstSource + i] !== directive)) {
    issues.push("app/globals.css must limit Tailwind sources to production code");
  }
  const styleImports = lines.slice(firstStyle, firstSource);
  if (styleImports.length !== expected.length
    || expected.some((path, i) => styleImports[i] !== `@import "./${path}" layer(mantine);`)) {
    issues.push(`app/globals.css must import every app/styles file once in layer(mantine), in file-name order: ${expected.join(", ")}`);
  }
  return issues;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !generatedDirectories.has(entry.name))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }));
  return nested.flat();
}

export async function runArchitectureCheck({ writeBaseline = false } = {}) {
  const violations = [];
  const files = await filesUnder(root);
  const cssFiles = files.filter((file) => extname(file) === ".css");
  const hasThemeStylesheet = cssFiles.includes(join(root, themeStylesheet));
  for (const file of cssFiles) {
    const path = relative(root, file);
    if (!allowedCss.has(path) && !(path.startsWith(stylesDirectory) && !path.slice(stylesDirectory.length).includes("/"))) {
      violations.push(`Unexpected authored stylesheet: ${path}`);
    }
  }

  // app/globals.css is only the ordered cascade manifest (layers, Tailwind, Mantine, surface stylesheets).
  const styleFiles = cssFiles
    .map((file) => relative(root, file))
    .filter((path) => path.startsWith(stylesDirectory))
    .sort();
  const globals = join(root, "app/globals.css");
  if ((await stat(globals)).isFile()) {
    violations.push(...validateGlobalsManifest(await readFile(globals, "utf8"), styleFiles, hasThemeStylesheet));
  }

  // One declaration per line, so diffs and agent edits stay precise.
  const authoredStyles = [...styleFiles, ...deferredStyles];
  if (hasThemeStylesheet) authoredStyles.push(themeStylesheet);
  for (const path of authoredStyles) {
    const lines = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
    if (lines.length > stylesheetLineBudget) violations.push(`${path} is ${lines.length} lines; split it (budget ${stylesheetLineBudget})`);
    let inComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const comment = inComment || trimmed.startsWith("/*");
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) inComment = true;
      else if (inComment && trimmed.includes("*/")) inComment = false;
      if (line.length > stylesheetLineLength) violations.push(`${path}:${index + 1} is longer than ${stylesheetLineLength} characters`);
      if (!comment && (trimmed.split(";").length > 2 || (trimmed.includes("{") && trimmed.includes(";")))) {
        violations.push(`${path}:${index + 1} has more than one declaration; format one per line`);
      }
    });
  }

  const sourceFiles = files.filter((file) => sourceExtensions.has(extname(file)));
  const legacyUiImports = {};
  for (const file of sourceFiles) {
    const path = relative(root, file);
    const source = await readFile(file, "utf8");
    const legacy = extractLegacyUiImports(file, source);
    if (Object.keys(legacy).length > 0) {
      legacyUiImports[path] = legacy;
    }

    const mantineSpecifiers = Object.keys(legacy).filter((spec) => spec.startsWith("@mantine/"));
    if (mantineSpecifiers.some((spec) => spec.endsWith("/styles.css"))) {
      violations.push(`Unlayered Mantine stylesheet import (use styles.layer.css in app/globals.css): ${path}`);
    }
    if (/from\s+["']recharts["']/.test(source)) violations.push(`Recharts import: ${path}`);
    if (
      mantineSpecifiers.some((spec) => !spec.endsWith(".css"))
      && !source.trimStart().startsWith('"use client"')
      && !source.trimStart().startsWith("'use client'")
      && !serverMantineAllowlist.has(path)
    ) {
      violations.push(`Mantine component used outside a client boundary: ${path}`);
    }
    if (/echarts\.init|import\(["']echarts["']\)/.test(source) && path !== "ui/charts/use-echarts.ts") {
      violations.push(`Direct ECharts lifecycle outside shared hook: ${path}`);
    }
    if (path !== "lib/api-schema.ts" && /\/v1\/dashboard(?:["'`?]|$)/.test(source)) {
      violations.push(`Monolithic dashboard API used instead of an interface lens: ${path}`);
    }
    if (/from\s+["']@\/lib\/(?:data|analysis|settings)["']/.test(source)) {
      violations.push(`Legacy server page loader used instead of an interface lens: ${path}`);
    }
    if (/#[0-9a-fA-F]{3,8}\b/.test(source) && !path.includes(".test.") && !rawColourAllowlist.has(path)) {
      violations.push(`Raw colour outside theme/palette: ${path}`);
    }
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    violations.push(`Unable to read legacy UI import baseline (${relative(root, baselinePath)}): ${error.message}`);
  }
  if (baseline?.files && typeof baseline.files === "object" && !Array.isArray(baseline.files)) {
    violations.push(...checkLegacyUiImports(legacyUiImports, baseline.files, { writeBaseline }));
  } else if (baseline !== undefined) {
    violations.push(`Invalid legacy UI import baseline format in ${relative(root, baselinePath)}`);
  }

  // Traverse runtime imports: shared portfolio calculations must remain usable by
  // both the BFF and the browser without pulling in view, transport or UI code.
  const authoredPaths = new Set(sourceFiles);
  const inspected = new Set();
  async function inspectPortfolioModule(file) {
    if (inspected.has(file)) return;
    inspected.add(file);
    const path = relative(root, file);
    if (!path.startsWith("lib/")) {
      violations.push(`Portfolio runtime dependency outside shared lib: ${path}`);
      return;
    }
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
        && ["use client", "use server"].includes(statement.expression.text)) {
        violations.push(`Framework boundary in pure portfolio dependency: ${path}`);
      }
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
      if (clause?.isTypeOnly || clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && !clause.name && clause.namedBindings.elements.every((item) => item.isTypeOnly)) continue;
      const target = specifier.text;
      const base = target.startsWith("@/") ? resolve(root, target.slice(2))
        : target.startsWith(".") ? resolve(file, "..", target) : undefined;
      if (!base) {
        violations.push(`External runtime import in pure portfolio dependency: ${path} -> ${target}`);
        continue;
      }
      const dependency = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
        .find((candidate) => authoredPaths.has(candidate));
      if (!dependency) violations.push(`Unresolved portfolio runtime dependency: ${path} -> ${target}`);
      else await inspectPortfolioModule(dependency);
    }
  }
  for (const file of sourceFiles) {
    if (relative(root, file).startsWith("lib/portfolio/") && !file.includes(".test.")) {
      await inspectPortfolioModule(file);
    }
  }

  if (writeBaseline && violations.length === 0) {
    const updated = Object.fromEntries(Object.keys(legacyUiImports).sort().map((path) => [path, legacyUiImports[path]]));
    await writeFile(baselinePath, `${JSON.stringify({ ...baseline, files: updated }, null, 2)}\n`, "utf8");
  }

  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const writeBaseline = process.argv.includes("--write-baseline");
  const violations = await runArchitectureCheck({ writeBaseline });
  if (violations.length) {
    console.error(["Frontend architecture check failed:", ...violations.map((item) => `- ${item}`)].join("\n"));
    process.exit(1);
  }
  console.log(writeBaseline ? "Wrote legacy UI import baseline and passed architecture check." : "Frontend architecture check passed.");
}
