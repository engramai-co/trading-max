import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// Exercise Next's real consumer alongside the pinned upstream braces fix.
const require = createRequire(import.meta.url);
const plugin = require.resolve("@next/eslint-plugin-next");
const { getRootDirs } = require(join(dirname(plugin), "utils/get-root-dirs.js"));
const root = mkdtempSync(join(tmpdir(), "trading-max-lint-"));
const web = join(root, "apps", "web");
const admin = join(root, "apps", "admin");
const shared = join(root, "packages", "shared");
for (const path of [web, admin, shared, join(root, "apps", ".hidden")]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(join(root, "apps", "README.md"), "synthetic fixture\n");
after(() => rmSync(root, { recursive: true, force: true }));

function resolve(rootDir) {
  return getRootDirs({ cwd: root, settings: { next: { rootDir } } }).sort();
}

test("default Next root stays the ESLint working directory", () => {
  assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
});

test("literal, wildcard and brace roots retain directory-only semantics", () => {
  assert.deepEqual(resolve(web), [web]);
  assert.deepEqual(resolve(join(root, "apps", "*")), [admin, web].sort());
  assert.deepEqual(resolve(join(root, "apps", "{web,admin}")), [admin, web].sort());
  assert.deepEqual(resolve(join(root, "apps", "README.md")), []);
  assert.deepEqual(resolve(join(root, "missing", "*")), []);
});

test("Next root arrays and Windows-style separators stay supported", () => {
  assert.deepEqual(resolve([web, shared, null, 7]), [shared, web].sort());
  assert.deepEqual(resolve(web.replaceAll("/", "\\")), [web]);
});

test("symlinked workspace roots stay discoverable", () => {
  const linked = join(root, "linked-web");
  symlinkSync(web, linked, "dir");
  assert.deepEqual(resolve(linked), [linked]);
});

test("deep brace input is rejected before recursive stack exhaustion", () => {
  // Run a potential denial-of-service regression in a killable child process.
  execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const braces = require(${JSON.stringify(require.resolve("braces"))});
    const pattern = '{'.repeat(3500) + 'a,b' + '}'.repeat(3500);
    for (const run of [() => braces(pattern), () => braces.expand(pattern),
      () => braces.parse(pattern, { maxDepth: 10000 })]) {
      assert.throws(run, error => error instanceof SyntaxError && /exceeds max depth/.test(error.message));
    }
    assert.deepEqual(braces.expand('apps/{web,admin}'), ['apps/web', 'apps/admin']);
    assert.equal(braces.stringify(braces.parse('{{a}}'), { escapeInvalid: true }), '{{a}}');
    for (const run of [braces.compile, braces.expand, braces.stringify]) {
      const ast = { type: 'root', nodes: [] };
      let node = ast;
      for (let depth = 0; depth < 102; depth++) {
        const child = { type: 'brace', nodes: [], parent: node };
        node.nodes.push(child);
        node = child;
      }
      assert.throws(() => run(ast), error => error instanceof RangeError && /exceeds max depth/.test(error.message));
    }
  `], { timeout: 3000, stdio: "pipe" });
});
