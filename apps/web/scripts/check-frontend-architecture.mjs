import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = new URL("../", import.meta.url).pathname;
const allowedCss = new Set(["app/globals.css", "app/desktop/desktop.css"]);
// Authored styles live in ordered surface files that app/globals.css imports.
const stylesDirectory = "app/styles/";
const stylesheetLineBudget = 900;
const stylesheetLineLength = 160;
const rawColourAllowlist = new Set(["ui/theme.ts", "ui/charts/palette.ts"]);
const serverMantineAllowlist = new Set(["app/layout.tsx", "ui/theme.ts"]);
// Playwright traces contain captured CSS/JS, not authored application code.
const generatedDirectories = new Set(["node_modules", ".next", ".run", "test-results", "playwright-report"]);
const violations = [];

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

const files = await filesUnder(root);
const cssFiles = files.filter((file) => extname(file) === ".css");
for (const file of cssFiles) {
  const path = relative(root, file);
  if (!allowedCss.has(path) && !(path.startsWith(stylesDirectory) && !path.slice(stylesDirectory.length).includes("/"))) {
    violations.push(`Unexpected authored stylesheet: ${path}`);
  }
}

// app/globals.css is only the ordered manifest of the surface stylesheets.
const styleFiles = cssFiles
  .map((file) => relative(root, file))
  .filter((path) => path.startsWith(stylesDirectory))
  .sort();
const globals = join(root, "app/globals.css");
if ((await stat(globals)).isFile()) {
  const manifest = (await readFile(globals, "utf8")).split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("/*"));
  const imports = manifest.map((line) => /^@import "\.\/(styles\/[\w.-]+\.css)";$/.exec(line.trim())?.[1] ?? null);
  if (imports.some((entry) => entry === null)) violations.push("app/globals.css may only @import ./styles/*.css files");
  const expected = styleFiles.map((path) => path.slice("app/".length));
  if (JSON.stringify(imports) !== JSON.stringify(expected)) {
    violations.push(`app/globals.css must import every app/styles file once, in file-name order: ${expected.join(", ")}`);
  }
}

// One declaration per line, so diffs and agent edits stay precise.
for (const path of [...styleFiles, "app/desktop/desktop.css"]) {
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

const sourceFiles = files.filter((file) => [".ts", ".tsx", ".js", ".mjs"].includes(extname(file)));
for (const file of sourceFiles) {
  const path = relative(root, file);
  const source = await readFile(file, "utf8");
  if (/from\s+["']recharts["']/.test(source)) violations.push(`Recharts import: ${path}`);
  if (
    /from\s+["']@mantine\//.test(source)
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

if (violations.length) {
  console.error(["Frontend architecture check failed:", ...violations.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}

console.log("Frontend architecture check passed.");
