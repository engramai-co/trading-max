import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkLegacyUiImports,
  extractLegacyUiImports,
  validateGlobalsManifest,
} from "./check-frontend-architecture.mjs";

test("extractLegacyUiImports captures static, type, re-export and dynamic legacy imports", () => {
  const source = [
    'import { Button, Select as MantineSelect } from "@mantine/core";',
    'import { useMediaQuery } from "@mantine/hooks";',
    'import type { Icon } from "@phosphor-icons/react";',
    'import { ArrowRight } from "lucide-react";',
    'export { Modal as Dialog } from "@mantine/core";',
    'export * from "@mantine/hooks";',
    'const notifications = import(`@mantine/notifications`);',
    'type Mod = typeof import("@mantine/notifications");',
  ].join("\n");

  assert.deepEqual(extractLegacyUiImports("sample.tsx", source), {
    "@mantine/core": ["<re-export:Modal>", "Button", "Select"],
    "@mantine/hooks": ["<re-export:*>", "useMediaQuery"],
    "@mantine/notifications": ["<dynamic>", "<type-import>"],
    "@phosphor-icons/react": ["Icon"],
  });
});

test("extractLegacyUiImports handles JavaScript and TypeScript module extensions", () => {
  for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
    const source = [
      'const core = require("@mantine/core");',
      'const hooks = require(`@mantine/hooks`);',
      'const notifications = import(`@mantine/notifications`);',
    ].join("\n");
    assert.deepEqual(extractLegacyUiImports(`sample.${extension}`, source), {
      "@mantine/core": ["<require>"],
      "@mantine/hooks": ["<require>"],
      "@mantine/notifications": ["<dynamic>"],
    });
  }
  assert.deepEqual(extractLegacyUiImports("sample.cts", 'import Core = require("@mantine/core");'), {
    "@mantine/core": ["<import-equals>"],
  });
  assert.deepEqual(extractLegacyUiImports("sample.jsx", [
    'const Button = () => <button>Click</button>;',
    'export { default as Notification } from "@mantine/notifications";',
  ].join("\n")), {
    "@mantine/notifications": ["<re-export:default>"],
  });
});

test("checkLegacyUiImports blocks interpolated imports and requires of legacy packages", () => {
  const path = "sample.tsx";
  const source = [
    'import(`@mantine/${packageName}`);',
    'require(`@phosphor-icons/${packageName}`);',
    'import(`@phosphor-icons/react${subpath}`);',
    'import((`@mantine/core/${subpath}`));',
    'import(String.raw`@mantine/hooks/${subpath}`);',
    'import(`@phosphor-icons${suffix}/react`);',
    'require(`@mantine${"x"}/core`);',
    'require(`@mantine${suffix}-compatible/core`);',
    'require(`@mantine-compatible/${packageName}`);',
  ].join("\n");
  const imports = extractLegacyUiImports(path, source);
  assert.deepEqual(imports, {
    "@mantine/": ["<dynamic-template>"],
    "@mantine/core/": ["<dynamic-template>"],
    "@mantine/hooks/": ["<dynamic-template>"],
    "@phosphor-icons": ["<dynamic-template>"],
    "@phosphor-icons/": ["<require-template>"],
    "@phosphor-icons/react": ["<dynamic-template>"],
  });
  assert.match(checkLegacyUiImports({ [path]: imports }, {})[0], /outside legacy UI baseline/);
});

test("checkLegacyUiImports blocks new files and newly added imports", () => {
  const baseline = {
    "workspace/a.tsx": {
      "@mantine/core": ["Button", "Select"],
      "@phosphor-icons/react": ["CaretDown"],
    },
    "workspace/b.tsx": {
      "@mantine/core": ["Modal"],
    },
  };

  assert.deepEqual(checkLegacyUiImports(baseline, baseline), []);

  // New file importing @mantine/* or @phosphor-icons/react fails.
  const newFileIssues = checkLegacyUiImports({
    "workspace/new-widget.tsx": {
      "@phosphor-icons/react": ["Plus"],
    },
  }, baseline, { writeBaseline: true });
  assert.equal(newFileIssues.length, 1);
  assert.match(newFileIssues[0], /outside legacy UI baseline.*workspace\/new-widget\.tsx/);

  // Existing file adding a new legacy package fails.
  const addedPackageIssues = checkLegacyUiImports({
    "workspace/b.tsx": {
      "@mantine/core": ["Modal"],
      "@phosphor-icons/react": ["X"],
    },
  }, baseline, { writeBaseline: true });
  assert.equal(addedPackageIssues.length, 1);
  assert.match(addedPackageIssues[0], /may not add legacy UI package @phosphor-icons\/react/);

  // Existing file adding a new symbol from an existing legacy package fails.
  const addedSymbolIssues = checkLegacyUiImports({
    "workspace/a.tsx": {
      "@mantine/core": ["Button", "Drawer", "Select"],
    },
  }, baseline, { writeBaseline: true });
  assert.equal(addedSymbolIssues.length, 1);
  assert.match(addedSymbolIssues[0], /may not add legacy UI imports from @mantine\/core \(Drawer\)/);
});

test("checkLegacyUiImports requires removals to shrink the baseline before a later reintroduction", () => {
  const original = {
    "workspace/page.tsx": {
      "@mantine/core": ["Button"],
    },
  };
  const removed = {};
  assert.match(checkLegacyUiImports(removed, original)[0], /--write-baseline.*workspace\/page\.tsx/);
  assert.deepEqual(checkLegacyUiImports(removed, original, { writeBaseline: true }), []);
  assert.match(checkLegacyUiImports(original, removed)[0], /outside legacy UI baseline/);
  assert.match(checkLegacyUiImports(original, removed, { writeBaseline: true })[0], /outside legacy UI baseline/);
});

test("validateGlobalsManifest enforces layer order, production sources, and optional theme aliases", () => {
  const valid = [
    "@layer theme, base, mantine, components, utilities;",
    '@import "tailwindcss/theme.css" layer(theme);',
    '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
    '@import "tw-animate-css";',
    '@import "shadcn/tailwind.css";',
    '@import "@mantine/core/styles.layer.css";',
    '@import "@mantine/notifications/styles.layer.css";',
    '@import "./styles/01-foundation.css" layer(mantine);',
    '@source "../{app,components,lib,ui,workspace}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";',
    '@source not "../**/*.{test,spec}.*";',
    '@source not "../**/{tests,__tests__,__mocks__}/**";',
    '@custom-variant dark (&:where([data-mantine-color-scheme="dark"], [data-mantine-color-scheme="dark"] *));',
  ].join("\n");

  assert.deepEqual(validateGlobalsManifest(valid, ["app/styles/01-foundation.css"]), []);
  assert.ok(validateGlobalsManifest(valid.replace(" source(none)", ""), ["app/styles/01-foundation.css"]).length);
  assert.ok(validateGlobalsManifest(valid, ["app/styles/01-foundation.css"], true).length);
  const withTheme = valid.replace(
    '@import "shadcn/tailwind.css";',
    '@import "shadcn/tailwind.css";\n@import "./shadcn-theme.css";',
  );
  assert.deepEqual(validateGlobalsManifest(withTheme, ["app/styles/01-foundation.css"], true), []);

  const withPreflight = valid.replace(
    '@import "tailwindcss/theme.css" layer(theme);',
    '@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/preflight.css" layer(base);',
  );
  assert.ok(validateGlobalsManifest(withPreflight, ["app/styles/01-foundation.css"]).some((m) => /preflight/i.test(m)));

  const wrongLayerOrder = valid.replace(
    "@layer theme, base, mantine, components, utilities;",
    "@layer theme, base, components, utilities, mantine;",
  );
  assert.ok(validateGlobalsManifest(wrongLayerOrder, ["app/styles/01-foundation.css"]).some((m) => /must start with/i.test(m)));
});
