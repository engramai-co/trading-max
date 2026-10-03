import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const patchedBraces = Object.freeze({
  resolved: "https://codeload.github.com/micromatch/braces/tar.gz/28d440b5dd449dbf1fe6f3506cf94ecca4d02660",
  integrity: "sha512-JDNujUUIiVjCw6vVXM92wZbpm+K+0KSTTqjcVa1zjjZLvfkOuDZmVHbKKjYRyE450ii6coDbuCIPqkX/bjmxWQ==",
});
export const patchedAdvisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const expiresAt = Date.parse("2026-11-03T00:00:00Z");

// npm matches this patched tarball's unchanged upstream 3.0.3 version. Only
// discount that exact advisory, source and integrity; never an entire package.
export function auditFindings(report, lock, now = Date.now()) {
  if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata) {
    throw new Error("npm audit did not return a complete version 2 report");
  }
  const findings = report.vulnerabilities;
  const braces = lock.packages?.["node_modules/braces"];
  const fixed = now < expiresAt && braces?.dev === true &&
    braces.resolved === patchedBraces.resolved && braces.integrity === patchedBraces.integrity;

  function covered(name, seen = new Set()) {
    const finding = findings[name];
    if (!fixed || seen.has(name) || !finding || !finding.via?.length || !finding.nodes?.length) return false;
    if (name === "braces" && (finding.nodes.length !== 1 || finding.nodes[0] !== "node_modules/braces")) return false;
    // Every reported location must be a locked development dependency.
    if (!finding.nodes.every(path => lock.packages?.[path]?.dev === true)) return false;
    const visited = new Set([...seen, name]);
    return finding.via.every(via => typeof via === "string" ? covered(via, visited) :
      name === "braces" && via.url === patchedAdvisory && via.name === "braces");
  }

  const high = Object.keys(findings).filter(name => ["high", "critical"].includes(findings[name].severity));
  const counts = report.metadata.vulnerabilities;
  if (!Number.isInteger(counts?.high) || !Number.isInteger(counts?.critical) ||
      counts.high + counts.critical !== high.length) {
    throw new Error("npm audit severity totals do not match its findings");
  }
  return { blocked: high.filter(name => !covered(name)), patched: high.filter(name => covered(name)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const audit = spawnSync("npm", ["audit", "--json", "--audit-level=high"], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  try {
    if (audit.error || ![0, 1].includes(audit.status)) throw new Error("npm audit failed to complete", { cause: audit.error });
    const report = JSON.parse(audit.stdout);
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    const result = auditFindings(report, lock);
    console.log(JSON.stringify({ ...result, metadata: report.metadata, patchExpiresAt: "2026-11-03" }, null, 2));
    if (result.blocked.length) process.exitCode = 1;
    if (result.patched.length) console.log(`Verified upstream patch for ${patchedAdvisory}; registry version findings retained above.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
