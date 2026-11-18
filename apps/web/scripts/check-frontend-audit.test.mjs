import assert from "node:assert/strict";
import { test } from "node:test";
import { auditFindings } from "./check-frontend-audit.mjs";

const advisory = {
  name: "picomatch", dependency: "picomatch", severity: "high", range: "<=4.0.7",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
};
const now = Date.parse("2026-11-18T00:00:00Z");
const nested = "node_modules/vite/node_modules/picomatch";

function fixture() {
  const report = {
    auditReportVersion: 2,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3 } },
    vulnerabilities: {
      picomatch: { name: "picomatch", severity: "high", range: "*", nodes: ["node_modules/picomatch", nested], via: [advisory] },
      vite: { name: "vite", severity: "high", range: ">=6", nodes: ["node_modules/vite"], via: ["picomatch"] },
      vitest: { name: "vitest", severity: "high", range: ">=3", nodes: ["node_modules/vitest"], via: ["vite", "picomatch"] },
    },
  };
  const lock = { packages: {
    "node_modules/picomatch": { dev: true, version: "2.3.2" },
    [nested]: { dev: true, version: "4.0.7" },
    "node_modules/vite": { dev: true, version: "8.3.8", dependencies: { picomatch: "^4.0.0" } },
    "node_modules/vitest": { dev: true, version: "5.1.0", peerDependencies: { vite: "^8" }, optionalDependencies: { picomatch: "^2" } },
  } };
  return { report, lock, check: (status = 1, when = now) => auditFindings(report, lock, status, when) };
}

const chain = ["picomatch", "vite", "vitest"];

test("accepts the advisory and declared, resolved development dependency paths", () => {
  const { check } = fixture();
  assert.deepEqual(check(), { blocked: [], accepted: chain });
});

test("a production or missing lock entry blocks every finding that relies on it", () => {
  const { lock, check } = fixture();
  delete lock.packages["node_modules/vite"].dev;
  assert.deepEqual(check().blocked, ["vite", "vitest"]);
  lock.packages[nested].dev = false;
  assert.deepEqual(check().blocked, chain);
  delete lock.packages[nested];
  assert.deepEqual(check().blocked, chain);
});

test("omitting an affected production copy from the report still blocks the chain", () => {
  const { report, lock, check } = fixture();
  lock.packages[nested].dev = false;
  report.vulnerabilities.picomatch.nodes = ["node_modules/picomatch"];
  assert.deepEqual(check().blocked, chain);
});

test("also checks omitted installations of dependent findings against their vulnerable range", () => {
  const { lock, check } = fixture();
  lock.packages["node_modules/another/node_modules/vite"] = { version: "7.0.0", dependencies: { picomatch: "^2" } };
  assert.deepEqual(check().blocked, ["vite", "vitest"]);
});

test("production copies outside the accepted advisory range can coexist with affected development copies", () => {
  const { lock, check } = fixture();
  lock.packages["node_modules/another/node_modules/picomatch"] = { version: "5.0.0" };
  assert.deepEqual(check().blocked, []);
});

test("a reported location for a different locked package cannot cover a finding", () => {
  const { report, check } = fixture();
  report.vulnerabilities.picomatch.nodes = ["node_modules/vite"];
  assert.deepEqual(check().blocked, chain);
});

test("an unrelated via link cannot borrow another package's exception", () => {
  const { lock, check } = fixture();
  delete lock.packages["node_modules/vitest"].peerDependencies;
  assert.deepEqual(check().blocked, ["vitest"]);
});

test("checks the closest locked installation and the declared dependency range", () => {
  const { lock, check } = fixture();
  const vite = lock.packages["node_modules/vite"];
  vite.dependencies.picomatch = "^2";
  assert.deepEqual(check().blocked, ["vite", "vitest"]);
  vite.dependencies.picomatch = "*";
  lock.packages["node_modules/vitest/node_modules/picomatch"] = { dev: true, version: "5.0.0" };
  lock.packages["node_modules/vitest"].optionalDependencies.picomatch = "*";
  assert.deepEqual(check().blocked, ["vitest"]);
});

test("an additional advisory, altered range or package mismatch blocks the entire dependent chain", () => {
  for (const change of [{ url: "https://example.invalid/another-advisory" }, { name: "other" }, { dependency: "other" }, { range: "<3" }]) {
    const { report, check } = fixture();
    report.vulnerabilities.picomatch.via.push({ ...advisory, ...change });
    assert.deepEqual(check().blocked, chain);
  }
});

test("the exception expires at midnight UTC", () => {
  const { check } = fixture();
  const expiry = Date.parse("2026-12-18T00:00:00Z");
  assert.deepEqual(check(1, expiry - 1).blocked, []);
  assert.deepEqual(check(1, expiry).blocked, chain);
});

test("unresolved dependencies and cycles fail closed", () => {
  for (const via of [["missing"], ["vitest"]]) {
    const { report, check } = fixture();
    report.vulnerabilities.vite.via = via;
    assert.deepEqual(check().blocked, ["vite", "vitest"]);
  }
});

test("rejects malformed reports, findings and advisory severities", () => {
  const { lock } = fixture();
  for (const invalid of [null, {}, { error: { code: "ENOLOCK" } }, { auditReportVersion: 2, vulnerabilities: {} }]) {
    assert.throws(() => auditFindings(invalid, lock, 1, now), /complete version 2 report/);
  }
  const { report, check } = fixture();
  report.vulnerabilities = [];
  assert.throws(check, /complete version 2 report/);
  for (const change of [
    { severity: "medium" }, { severity: "low" }, { name: "other" }, { range: "invalid" }, { nodes: [] }, { nodes: "not an array" },
    { nodes: [null] }, { via: [] }, { via: "not an array" }, { via: [null] }, { via: [{ ...advisory, severity: "unknown" }] },
  ]) {
    const { report, check } = fixture();
    Object.assign(report.vulnerabilities.picomatch, change);
    assert.throws(check, /invalid finding/);
  }
});

test("reconciles each severity bucket and the overall total", () => {
  for (const change of [
    { info: 1 }, { low: 1 }, { moderate: 1 }, { high: 2, critical: 1 },
    { critical: undefined }, { low: "0" }, { total: 2 }, { unexpected: 0 },
  ]) {
    const { report, check } = fixture();
    Object.assign(report.metadata.vulnerabilities, change);
    assert.throws(check, /severity totals/);
  }
});

test("the npm exit status must match the high threshold, before applying any exception", () => {
  const { report, check } = fixture();
  assert.throws(() => check(0), /exit status/);
  const totals = report.metadata.vulnerabilities;
  report.vulnerabilities = {};
  Object.assign(totals, { high: 0, total: 0 });
  assert.throws(() => check(1), /exit status/);
  assert.deepEqual(check(0), { blocked: [], accepted: [] });

  const low = { ...advisory, severity: "low" };
  report.vulnerabilities.picomatch = { name: "picomatch", severity: "low", range: "*", nodes: [nested], via: [low] };
  Object.assign(totals, { low: 1, total: 1 });
  assert.deepEqual(check(0), { blocked: [], accepted: [] });
  assert.throws(() => check(1), /exit status/);
  report.vulnerabilities.picomatch.severity = "critical";
  Object.assign(totals, { low: 0, critical: 1 });
  assert.throws(() => check(0), /exit status/);
});
