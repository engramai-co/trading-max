import { test, type Browser, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { backendFixture, ticker } from "./fixtures";
import { installProbe, moments, scenarios, type Sample } from "./milestones";

const profiles = {
  unthrottled: { latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "ethernet" },
  "Slow 4G": { latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750, connectionType: "cellular4g" },
} as const;
const modes = ["direct", "rail"] as const;
const viewport = { width: 1440, height: 900 };
const milestoneTimeout = 45_000;
const standalone = resolve(".next/standalone");

type Network = keyof typeof profiles;
type Mode = typeof modes[number];
type Scenario = typeof scenarios[number];
type Summary = Record<typeof moments[number], { median: number; p90: number } | null>;
type Cell = { route: string; name: string; mode: Mode; network: Network; samples: Sample[]; summary: Summary };

function integer(name: string, fallback: number, min: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer ≥ ${min}`);
  return value;
}

async function standaloneServer() {
  const entries = await readdir(standalone);
  if (entries.some((entry) => /^\.env(?:\.production)?(?:\.local)?$/.test(entry))) {
    throw new Error("Rebuild in a clean worktree without a local .env file.");
  }
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const { port } = reserve.address() as { port: number };
  await new Promise<void>((done) => reserve.close(() => done()));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: standalone,
    env: { NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), PORTFOLIO_BACKEND_URL: "http://127.0.0.1:9" },
  });
  const exit = once(child, "exit").then(() => undefined, () => undefined);
  const kill = () => { child.kill("SIGTERM"); };
  process.once("exit", kill);
  async function stop() {
    kill();
    await Promise.race([exit, delay(2_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    process.removeListener("exit", kill);
  }
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const until = performance.now() + 10_000;
  while (performance.now() < until) {
    // The readiness message must come from this child, not any other local service.
    if (output.includes(origin) && /Ready in/.test(output)) return { origin, stop };
    if (child.exitCode !== null) break;
    await delay(50);
  }
  await stop();
  throw new Error("Standalone server did not start. Run npm run build first.\n" + output);
}

function railSelector(href: string) {
  return `.mx-sidebar nav a[href="${href}"]`;
}

async function readSample(page: Page, scenario: Scenario): Promise<Sample> {
  try {
    const handle = await page.waitForFunction(({ hasCharts }) => {
      // Keep the condition in the browser so transport time cannot inflate a milestone.
      const result = (window as Window & { __loadingBenchmark?: { result: Sample } }).__loadingBenchmark?.result;
      return result && result.firstContent !== null && result.structure !== null && result.figure !== null
        && (!hasCharts || result.charts !== null) ? result : false;
    }, { hasCharts: scenario.charts.length > 0 }, { timeout: milestoneTimeout });
    const result = await handle.jsonValue();
    if (!result) throw new Error("The milestone probe did not return a sample.");
    return result;
  } catch (error) {
    const partial = await page.evaluate(() => (window as Window & { __loadingBenchmark?: { result: Sample } }).__loadingBenchmark?.result)
      .catch(() => undefined);
    throw new Error(`Timed out measuring ${scenario.name} at ${new URL(page.url()).pathname}. Observed: ${JSON.stringify(partial)}`, { cause: error });
  }
}

async function sample(browser: Browser, origin: string, scenario: Scenario, mode: Mode, network: Network, upstreamDelayMs: number) {
  const context = await browser.newContext({ viewport, locale: "en-GB", timezoneId: "Europe/London", serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(milestoneTimeout);
    const errors = new Set<string>();
    page.on("pageerror", (error) => { errors.add(error.message); });
    // A context-wide deny rule covers the first request of any popup as well.
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== "GET") return route.abort();
      if (url.pathname.startsWith("/api/company-logo/")) return route.fulfill({ status: 204 });
      if (url.pathname.startsWith("/api/")) {
        errors.add("Unexpected API path: " + url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await page.route("**/api/backend/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== "GET") return route.fallback();
      const json = backendFixture(url);
      if (json === undefined) {
        errors.add("No synthetic fixture for " + url.pathname);
        return route.fulfill({ status: 501, json: { detail: "No synthetic benchmark fixture" } });
      }
      await delay(upstreamDelayMs);
      await route.fulfill({ json });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...profiles[network] });

    // Rail targets start on a loaded Overview, except Overview itself (which starts on Holdings).
    const entry = mode === "direct" ? scenario : scenarios[scenario.url === "/" ? 1 : 0];
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.addInitScript(installProbe, { scenario: entry });
    try {
      const response = await page.goto(origin + entry.url, { waitUntil: "commit" });
      if (!response?.ok()) throw new Error("The standalone build did not serve " + entry.url);
      const initial = await readSample(page, entry);
      if (mode === "direct") return initial;
      const railClick = railSelector(scenario.rail ?? scenario.url);
      await page.evaluate(installProbe, { scenario, railClick });
      await page.locator(railClick).click();
      if (scenario.tab) await page.getByRole("tab", { name: scenario.tab, exact: true }).click();
      const result = await readSample(page, scenario);
      if (scenario.name === "Research" && !(await page.locator(".mx-security-header").innerText()).includes(ticker)) {
        throw new Error("The research rail did not open the synthetic ticker.");
      }
      return result;
    } finally {
      if (errors.size) throw new Error([...errors].join("\n"));
    }
  } finally {
    await context.close();
  }
}

function summarize(samples: Sample[]) {
  return Object.fromEntries(moments.map((moment) => {
    const values = samples.flatMap((sample) => sample[moment] ?? []).sort((a, b) => a - b);
    if (!values.length) return [moment, null];
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    return [moment, { median, p90: values[Math.ceil(values.length * 0.9) - 1] }];
  })) as Summary;
}

function markdown(cells: Cell[], runs: number, upstreamDelayMs: number, elapsedSeconds: number) {
  return [
    "# Loading benchmark", "",
    `${runs} samples per row · ${upstreamDelayMs} ms upstream delay · ${elapsedSeconds.toFixed(1)} s total. Times are median / p90 in ms.`,
    "First content is native FCP for direct loads and a target content frame for rail navigation. — means no primary chart.",
    "",
    "| Page | Entry | Network | First content | Structure | Figure + time | Charts |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...cells.map(({ name, mode, network, summary }) => {
      const values = moments.map((key) => {
        const metric = summary[key];
        return metric ? `${Math.round(metric.median)} / ${Math.round(metric.p90)}` : "—";
      });
      return `| ${[name, mode, network, ...values].join(" | ")} |`;
    }),
    "",
  ].join("\n");
}

test("standalone workspace loading benchmark", async ({ browser, browserName }) => {
  if (browserName !== "chromium") throw new Error("The loading benchmark requires Chromium for CDP throttling.");
  const runs = integer("BENCH_LOADING_RUNS", 5, 1);
  const upstreamDelayMs = integer("BENCH_LOADING_DELAY_MS", 250, 0);
  const label = process.env.BENCH_LOADING_LABEL ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label)) throw new Error("Use letters, digits, dashes or underscores in BENCH_LOADING_LABEL.");
  const buildId = (await readFile(resolve(standalone, ".next/BUILD_ID"), "utf8")).trim();
  const started = performance.now();
  const server = await standaloneServer();
  const cells: Cell[] = [];
  try {
    for (const network of Object.keys(profiles) as Network[]) {
      for (const scenario of scenarios) {
        for (const mode of modes) {
          const samples: Sample[] = [];
          for (let run = 1; run <= runs; run++) {
            try {
              samples.push(await sample(browser, server.origin, scenario, mode, network, upstreamDelayMs));
            } catch (error) {
              throw new Error(`${scenario.name} · ${mode} · ${network} · run ${run}/${runs}`, { cause: error });
            }
          }
          cells.push({ route: scenario.url, name: scenario.name, mode, network, samples, summary: summarize(samples) });
          console.log(`Measured ${scenario.name} · ${mode} · ${network}`);
        }
      }
    }
  } finally {
    await server.stop();
  }
  const elapsedSeconds = (performance.now() - started) / 1_000;
  const output = resolve("../../benchmarks/loading", label);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "results.json"), JSON.stringify({
    schemaVersion: 1, label, buildId, elapsedSeconds, runs, upstreamDelayMs, viewport, profiles,
    environment: { node: process.version, chromium: browser.version(), platform: platform(), arch: arch(), release: release() },
    cells,
  }, null, 2) + "\n");
  await writeFile(resolve(output, "results.md"), markdown(cells, runs, upstreamDelayMs, elapsedSeconds));
  console.log(`Results: ${output}`);
});
