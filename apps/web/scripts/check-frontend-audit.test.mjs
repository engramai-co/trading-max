import assert from "node:assert/strict";
import { test } from "node:test";
import { auditFindings } from "./check-frontend-audit.mjs";

const advisory = { name: "picomatch", dependency: "picomatch", url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf" };
const now = Date.parse("2026-11-18T00:00:00Z");
const nested = "node_modules/vite/node_modules/picomatch";

function fixture() {
  return {
    report: { auditReportVersion: 2, metadata: { vulnerabilities: { high: 3, critical: 0 } }, vulnerabilities: {
      picomatch: { severity: "high", nodes: ["node_modules/picomatch", nested], via: [advisory] },
      vite: { severity: "high", nodes: ["node_modules/vite"], via: ["picomatch"] },
      vitest: { severity: "high", nodes: ["node_modules/vitest"], via: ["vite", "picomatch"] },
    } },
    lock: { packages: {
      "node_modules/picomatch": { dev: true },
      [nested]: { dev: true },
      "node_modules/vite": { dev: true },
      "node_modules/vitest": { dev: true },
    } },
  };
}

test("accepts the advisory and dependent findings when every path is development-only", () => {
  const { report, lock } = fixture();
  assert.deepEqual(auditFindings(report, lock, now), { blocked: [], accepted: ["picomatch", "vite", "vitest"] });
});

test("a production or missing lock entry blocks every finding that relies on it", () => {
  const { report, lock } = fixture();
  delete lock.packages["node_modules/vite"].dev;
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["vite", "vitest"]);
  lock.packages[nested].dev = false;
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["picomatch", "vite", "vitest"]);
  delete lock.packages[nested];
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["picomatch", "vite", "vitest"]);
});

test("a reported location for a different locked package cannot cover a finding", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.picomatch.nodes = ["node_modules/vite"];
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["picomatch", "vite", "vitest"]);
});

test("an additional advisory or a package mismatch blocks the entire dependent chain", () => {
  for (const change of [{ url: "https://example.invalid/another-advisory" }, { name: "other" }, { dependency: "other" }]) {
    const { report, lock } = fixture();
    report.vulnerabilities.picomatch.via.push({ ...advisory, ...change });
    assert.deepEqual(auditFindings(report, lock, now).blocked, ["picomatch", "vite", "vitest"]);
  }
});

test("the exception expires at midnight UTC", () => {
  const { report, lock } = fixture();
  const expiry = Date.parse("2026-12-18T00:00:00Z");
  assert.deepEqual(auditFindings(report, lock, expiry - 1).blocked, []);
  assert.deepEqual(auditFindings(report, lock, expiry).blocked, ["picomatch", "vite", "vitest"]);
});

test("unresolved dependencies, cycles and empty paths fail closed", () => {
  for (const via of [["missing"], ["vitest"], []]) {
    const { report, lock } = fixture();
    report.vulnerabilities.vite.via = via;
    assert.deepEqual(auditFindings(report, lock, now).blocked, ["vite", "vitest"]);
  }
});

test("audit errors and inconsistent severity counts cannot pass", () => {
  const { report, lock } = fixture();
  for (const invalid of [{}, { error: { code: "ENOLOCK" } }, { auditReportVersion: 2, vulnerabilities: {} }]) {
    assert.throws(() => auditFindings(invalid, lock, now));
  }
  for (const counts of [{ high: 0, critical: 0 }, { high: 2, critical: 1 }]) {
    report.metadata.vulnerabilities = counts;
    assert.throws(() => auditFindings(report, lock, now), /severity totals/);
  }
});
