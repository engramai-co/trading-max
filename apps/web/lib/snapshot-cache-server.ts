import "server-only";

import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after } from "next/server";
import type { QueryKey } from "@tanstack/react-query";
import { backendUrl } from "./backend";
import {
  isSnapshotEntry, packSnapshotCache, readSnapshotCache, snapshotCacheMaxSize, type SnapshotCacheEntry,
} from "./snapshot-cache";

export function snapshotCacheScope() {
  const workspace = process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID;
  const root = process.env.TRADING_MAX_STATE_ROOT;
  return createHash("sha256")
    .update(JSON.stringify(desktopCacheFile() ? ["desktop", workspace, root] : [process.env.TRADING_MAX_ENV, root, backendUrl()]))
    .digest("hex");
}

function desktopCacheFile() {
  // The supervisor verifies the workspace and binds the service to loopback.
  // Its origin has an ephemeral port, so WebView localStorage cannot survive a
  // relaunch. Keep this derived file with its workspace, outside the app bundle.
  const root = process.env.TRADING_MAX_STATE_ROOT;
  if (root && process.env.HOSTNAME === "127.0.0.1" && process.env.TRADING_MAX_DESKTOP_SUPERVISOR_PID &&
      (process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID || process.env.TRADING_MAX_ENV === "desktop-preview")) {
    return join(root, "runtime", "web-snapshot-cache-v1", "queries.json");
  }
}

async function loadFile(file: string, scope: string): Promise<SnapshotCacheEntry[]> {
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size > snapshotCacheMaxSize) return [];
      return readSnapshotCache(await handle.readFile("utf8"), scope);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

export async function desktopSnapshotCache(scope: string) {
  const file = desktopCacheFile();
  return file ? { entries: await loadFile(file, scope) } : null;
}

// Route bundles can evaluate this module separately. Serialize read/merge/rename
// across them; the supervisor already guarantees one owner process per workspace.
const worker = globalThis as typeof globalThis & { tradingMaxSnapshotCacheWrite?: Promise<void> };
function remember(file: string, key: QueryKey, data: unknown, updatedAt: number) {
  const entry = { key, data, updatedAt };
  if (!isSnapshotEntry(entry, Date.now())) return;
  const scope = snapshotCacheScope();
  const write = (worker.tradingMaxSnapshotCacheWrite ?? Promise.resolve()).then(async () => {
    const temporary = file + "." + process.pid + ".tmp";
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const entries = await loadFile(file, scope);
      await writeFile(temporary, packSnapshotCache([entry, ...entries], scope), { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
  worker.tradingMaxSnapshotCacheWrite = write;
  return write;
}

/** Persist only responses produced by the bundled service, never browser input. */
export function rememberDesktopSnapshot(key: QueryKey, data: unknown) {
  const file = desktopCacheFile();
  const updatedAt = Date.now();
  if (file) after(() => remember(file, key, data, updatedAt));
}

async function readResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > snapshotCacheMaxSize) return undefined;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function rememberDesktopSnapshotResponse(key: QueryKey, response: Response) {
  const file = desktopCacheFile();
  if (!file || !response.ok || Number(response.headers.get("content-length")) > snapshotCacheMaxSize) return;
  const updatedAt = Date.now();
  const data = readResponse(response.clone()).catch(() => undefined);
  after(async () => remember(file, key, await data, updatedAt));
}
