import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const webRoot = process.cwd();
const standaloneRoot = path.join(webRoot, ".next", "standalone");
const staticSource = path.join(webRoot, ".next", "static");
const staticTarget = path.join(standaloneRoot, ".next", "static");
const publicSource = path.join(webRoot, "public");
const publicTarget = path.join(standaloneRoot, "public");

await mkdir(path.dirname(staticTarget), { recursive: true });
await cp(staticSource, staticTarget, { force: true, recursive: true });
await cp(publicSource, publicTarget, { force: true, recursive: true });
