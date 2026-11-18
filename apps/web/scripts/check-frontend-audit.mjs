import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const exceptions = [
  {
    package: "picomatch",
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    reason: "Lint and test tooling depend on picomatch. No patched release is available.",
    expiresAt: "2026-12-18T00:00:00Z",
  },
];

export function auditFindings(report, lock, now = Date.now()) {
  if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata) {
    throw new Error("npm audit did not return a complete version 2 report");
  }
  const findings = report.vulnerabilities;
  const active = exceptions.filter(entry => now < Date.parse(entry.expiresAt));

  function covered(name, seen = new Set()) {
    const finding = findings[name];
    if (seen.has(name) || !finding?.via?.length || !finding.nodes?.length) return false;
    if (!finding.nodes.every(path =>
      path.split("node_modules/").at(-1) === name && lock.packages?.[path]?.dev === true
    )) return false;
    const visited = new Set([...seen, name]);
    return finding.via.every(via => {
      if (typeof via === "string") return covered(via, visited);
      return via?.name === name && via.dependency === name &&
        active.some(entry => entry.package === name && entry.url === via.url);
    });
  }

  const blocked = [];
  const accepted = [];
  for (const severity of ["high", "critical"]) {
    const names = Object.keys(findings).filter(name => findings[name].severity === severity);
    if (report.metadata.vulnerabilities?.[severity] !== names.length) {
      throw new Error("npm audit severity totals do not match its findings");
    }
    for (const name of names) {
      (covered(name) ? accepted : blocked).push(name);
    }
  }
  return { blocked, accepted };
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
    console.log(JSON.stringify({ ...result, exceptions, metadata: report.metadata }, null, 2));
    if (result.blocked.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
