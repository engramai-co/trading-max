import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = join(webRoot, ".next");

async function readAssetSizes(relPaths) {
  const unique = [...new Set(relPaths)].sort();
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const rel of unique) {
    const clean = rel.replace(/^\/?_next\//, "").replace(/^\.next\//, "");
    const buf = await readFile(join(nextDir, clean));
    rawBytes += buf.length;
    gzipBytes += gzipSync(buf, { level: 9 }).length;
  }
  return { rawBytes, gzipBytes, chunkCount: unique.length };
}

async function findClientManifests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findClientManifests(full));
    } else if (entry.name === "page_client-reference-manifest.js") {
      results.push(full);
    }
  }
  return results;
}

function routeFromManifestPath(appDir, manifestPath) {
  const rel = relative(appDir, dirname(manifestPath)).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

async function entryCssByRoute() {
  const appDir = join(nextDir, "server", "app");
  const manifests = await findClientManifests(appDir);
  const byRoute = new Map();
  for (const manifestPath of manifests) {
    const route = routeFromManifestPath(appDir, manifestPath);
    const source = await readFile(manifestPath, "utf8");
    const marker = "globalThis.__RSC_MANIFEST[";
    const start = source.indexOf(marker);
    if (start < 0) continue;
    const eq = source.indexOf("=", start);
    const jsonText = source.slice(eq + 1).trim().replace(/;$/, "");
    const parsed = JSON.parse(jsonText);
    const cssSet = new Set();
    for (const entries of Object.values(parsed.entryCSSFiles ?? {})) {
      for (const entry of entries) {
        if (entry?.path) cssSet.add(entry.path);
      }
    }
    byRoute.set(route, await readAssetSizes([...cssSet]));
  }
  return byRoute;
}

export async function collectBundleBaseline() {
  const pkg = JSON.parse(await readFile(join(webRoot, "package.json"), "utf8"));
  const buildManifest = JSON.parse(await readFile(join(nextDir, "build-manifest.json"), "utf8"));
  const routeStats = JSON.parse(await readFile(join(nextDir, "diagnostics", "route-bundle-stats.json"), "utf8"));
  const cssMap = await entryCssByRoute();

  const sharedRuntimeJs = await readAssetSizes([
    ...(buildManifest.rootMainFiles ?? []),
    ...(buildManifest.polyfillFiles ?? []),
  ]);

  const routes = [];
  for (const entry of [...routeStats].sort((a, b) => a.route.localeCompare(b.route))) {
    const js = await readAssetSizes(entry.firstLoadChunkPaths ?? []);
    const css = cssMap.get(entry.route) ?? { rawBytes: 0, gzipBytes: 0, chunkCount: 0 };
    routes.push({
      route: entry.route,
      firstLoadJsBytes: entry.firstLoadUncompressedJsBytes,
      firstLoadJsGzipBytes: js.gzipBytes,
      firstLoadJsChunks: js.chunkCount,
      entryCssBytes: css.rawBytes,
      entryCssGzipBytes: css.gzipBytes,
      entryCssChunks: css.chunkCount,
    });
  }

  const staticChunksDir = join(nextDir, "static", "chunks");
  const allChunkNames = await readdir(staticChunksDir);
  const allJs = await readAssetSizes(allChunkNames.filter((n) => n.endsWith(".js")).map((n) => `static/chunks/${n}`));
  const allCss = await readAssetSizes(allChunkNames.filter((n) => n.endsWith(".css")).map((n) => `static/chunks/${n}`));

  return {
    schemaVersion: 1,
    stage: "initial-bundle-baseline",
    appVersion: pkg.version,
    toolchain: {
      next: pkg.dependencies.next,
      react: pkg.dependencies.react,
      mantineCore: pkg.dependencies["@mantine/core"],
      tailwindcss: pkg.devDependencies.tailwindcss,
      shadcn: pkg.devDependencies.shadcn,
    },
    source: {
      bundleStats: "apps/web/.next/diagnostics/route-bundle-stats.json",
      buildManifest: "apps/web/.next/build-manifest.json",
      cssManifests: "apps/web/.next/server/app/**/page_client-reference-manifest.js",
    },
    sharedRuntimeJs,
    totalStaticAssets: {
      js: allJs,
      css: allCss,
    },
    routes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArgIndex = process.argv.indexOf("--write");
  const report = await collectBundleBaseline();
  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (outArgIndex >= 0) {
    const target = process.argv[outArgIndex + 1]
      ? resolve(process.argv[outArgIndex + 1])
      : join(webRoot, "scripts", "bundle-load-baseline.json");
    await writeFile(target, formatted, "utf8");
    console.log(`Wrote bundle baseline to ${relative(webRoot, target)}`);
  } else {
    process.stdout.write(formatted);
  }
}
