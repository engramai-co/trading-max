import assert from "node:assert/strict";
import { test } from "node:test";
import { auditFindings, patchedAdvisory, patchedBraces } from "./check-frontend-audit.mjs";

const now = Date.parse("2026-10-03T00:00:00Z");
function fixture() {
  return {
    report: { auditReportVersion: 2, metadata: { vulnerabilities: { high: 2, critical: 0 } }, vulnerabilities: {
      braces: { severity: "high", nodes: ["node_modules/braces"], via: [{ name: "braces", url: patchedAdvisory }] },
      micromatch: { severity: "high", nodes: ["node_modules/micromatch"], via: ["braces"] },
    } },
    lock: { packages: {
      "node_modules/braces": { ...patchedBraces, dev: true },
      "node_modules/micromatch": { dev: true },
    } },
  };
}
test("only the pinned patch and its transitive advisory are covered", () => {
  const { report, lock } = fixture();
  assert.deepEqual(auditFindings(report, lock, now), { blocked: [], patched: ["braces", "micromatch"] });
});
test("new advisories on the same package still fail", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.braces.via.push({ name: "braces", url: "https://example.invalid/new-advisory" });
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["braces", "micromatch"]);
});
test("an altered pin, digest, runtime dependency or second copy fails", () => {
  for (const change of [
    ({ lock }) => { lock.packages["node_modules/braces"].resolved += "-changed"; },
    ({ lock }) => { lock.packages["node_modules/braces"].integrity = "wrong"; },
    ({ lock }) => { lock.packages["node_modules/braces"].dev = false; },
    ({ report }) => { report.vulnerabilities.braces.nodes.push("node_modules/other/node_modules/braces"); },
  ]) {
    const data = fixture();
    change(data);
    assert.equal(auditFindings(data.report, data.lock, now).blocked.length, 2);
  }
});
test("expired patches, missing dependencies and cycles fail closed", () => {
  const { report, lock } = fixture();
  assert.equal(auditFindings(report, lock, Date.parse("2026-11-03")).blocked.length, 2);
  report.vulnerabilities.micromatch.via = ["missing"];
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["micromatch"]);
  report.vulnerabilities.micromatch.via = ["micromatch"];
  assert.deepEqual(auditFindings(report, lock, now).blocked, ["micromatch"]);
});
test("audit errors or incomplete responses cannot pass", () => {
  for (const report of [{}, { error: { code: "ENOLOCK" } }, { auditReportVersion: 2, vulnerabilities: {} }]) {
    assert.throws(() => auditFindings(report, fixture().lock, now));
  }
  const { report, lock } = fixture();
  report.vulnerabilities = {};
  assert.throws(() => auditFindings(report, lock, now));
});
