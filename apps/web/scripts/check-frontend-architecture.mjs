import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const allowedCss = new Set(["app/globals.css"]);
const rawColourAllowlist = new Set(["ui/theme.ts", "ui/charts/palette.ts"]);
const serverMantineAllowlist = new Set(["app/layout.tsx", "ui/theme.ts"]);
const violations = [];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => entry.name !== "node_modules" && entry.name !== ".next")
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
  if (!allowedCss.has(path)) violations.push(`Unexpected authored stylesheet: ${path}`);
}

const globals = join(root, "app/globals.css");
if ((await stat(globals)).isFile()) {
  const lines = (await readFile(globals, "utf8")).split(/\r?\n/).length;
  if (lines > 100) violations.push(`app/globals.css is ${lines} lines; budget is 100`);
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

if (violations.length) {
  console.error(["Frontend architecture check failed:", ...violations.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}

console.log("Frontend architecture check passed.");
