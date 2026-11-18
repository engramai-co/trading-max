import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import semver from "semver";

const exceptions = [
  {
    package: "picomatch",
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    range: "<=4.0.7",
    reason: "Lint and test tooling depend on picomatch. No patched release is available.",
    expiresAt: "2026-12-18T00:00:00Z",
  },
];

const severities = ["info", "low", "moderate", "high", "critical"];
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;
const isRange = value => isText(value) && semver.validRange(value) !== null;

function validCause(via, findingSeverity) {
  if (isText(via)) return true;
  return isRecord(via) && isText(via.name) && isText(via.dependency) && isText(via.url) &&
    isRange(via.range) && severities.includes(via.severity) &&
    severities.indexOf(via.severity) <= severities.indexOf(findingSeverity);
}

function validateReport(report, status) {
  const totals = report?.metadata?.vulnerabilities;
  if (report?.error || report?.auditReportVersion !== 2 || !isRecord(report.vulnerabilities) || !isRecord(totals)) {
    throw new Error("npm audit did not return a complete version 2 report");
  }
  const counts = Object.fromEntries(severities.map(level => [level, 0]));
  const findings = Object.entries(report.vulnerabilities);
  for (const [name, finding] of findings) {
    if (!isRecord(finding) || finding.name !== name || !severities.includes(finding.severity) ||
        !isRange(finding.range) || !Array.isArray(finding.nodes) || !finding.nodes.length ||
        !finding.nodes.every(isText) || new Set(finding.nodes).size !== finding.nodes.length ||
        !Array.isArray(finding.via) || !finding.via.length || !finding.via.every(via => validCause(via, finding.severity))) {
      throw new Error(`npm audit returned an invalid finding for ${name}`);
    }
    counts[finding.severity]++;
  }
  if (Object.keys(totals).length !== severities.length + 1 || totals.total !== findings.length ||
      severities.some(level => totals[level] !== counts[level])) {
    throw new Error("npm audit severity totals do not match its findings");
  }
  const expectedStatus = counts.high + counts.critical > 0 ? 1 : 0;
  if (status !== expectedStatus) throw new Error("npm audit exit status disagrees with its high threshold");
}

function lockedDevelopmentNodes(finding, packages, ranges) {
  const reported = new Set(finding.nodes);
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || (entry.name ?? path.split("node_modules/").at(-1)) !== finding.name) continue;
    if (!semver.valid(entry.version)) return false;
    if (!ranges.some(range => semver.satisfies(entry.version, range, { includePrerelease: true }))) continue;
    if (entry.dev !== true || !reported.delete(path)) return false;
  }
  return reported.size === 0;
}

function lockedDependency(packages, from, name) {
  if (!Object.hasOwn(packages, from)) return;
  const entry = packages[from];
  const spec = entry.optionalDependencies?.[name] ?? entry.dependencies?.[name] ?? entry.peerDependencies?.[name];
  if (!isRange(spec)) return;
  // Resolve the nearest installation, including hoisted and scoped dependencies.
  let prefix = `${from}/`;
  for (;;) {
    const path = `${prefix}node_modules/${name}`;
    if (Object.hasOwn(packages, path)) {
      if (semver.satisfies(packages[path].version, spec)) return path;
      return;
    }
    if (!prefix) return;
    prefix = prefix.slice(0, prefix.lastIndexOf("node_modules/"));
  }
}

export function auditFindings(report, lock, status, now = Date.now()) {
  validateReport(report, status);
  const findings = report.vulnerabilities;
  const active = exceptions.filter(entry => now < Date.parse(entry.expiresAt));

  function covered(name, seen = new Set()) {
    if (seen.has(name) || !Object.hasOwn(findings, name)) return false;
    const finding = findings[name];
    const visited = new Set([...seen, name]);
    const ranges = new Set();
    for (const via of finding.via) {
      if (typeof via === "string") {
        if (!covered(via, visited)) return false;
        const affected = findings[via].nodes;
        if (!finding.nodes.every(path => affected.includes(lockedDependency(lock.packages, path, via)))) return false;
        ranges.add(finding.range);
      } else {
        const exception = active.find(entry => entry.package === name && entry.url === via.url);
        if (!exception || via.name !== name || via.dependency !== name || via.range !== exception.range) return false;
        ranges.add(exception.range);
      }
    }
    return lockedDevelopmentNodes(finding, lock.packages, [...ranges]);
  }

  const blocked = [];
  const accepted = [];
  for (const [name, finding] of Object.entries(findings)) {
    if (finding.severity === "high" || finding.severity === "critical") {
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
    const result = auditFindings(report, lock, audit.status);
    console.log(JSON.stringify({ ...result, exceptions, metadata: report.metadata }, null, 2));
    if (result.blocked.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
