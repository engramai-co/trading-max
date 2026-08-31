import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "trading-max-api-types-"));
const generatedPath = join(temporaryDirectory, "api-schema.ts");

try {
  const result = spawnSync(
    resolve(appRoot, "node_modules/.bin/openapi-typescript"),
    [resolve(appRoot, "../../contracts/openapi.json"), "-o", generatedPath],
    { cwd: appRoot, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);

  const committed = readFileSync(resolve(appRoot, "lib/api-schema.ts"), "utf8");
  const generated = readFileSync(generatedPath, "utf8");
  if (committed !== generated) {
    console.error(
      "Generated API types are stale. Run `npm run generate:api-types`.",
    );
    process.exit(1);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
