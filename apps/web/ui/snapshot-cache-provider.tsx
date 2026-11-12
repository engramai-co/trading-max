"use client";

import { hashKey, IsRestoringProvider, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  isSnapshotEntry, packSnapshotCache, readSnapshotCache, snapshotCacheStorageKey, type SnapshotCacheEntry,
} from "@/lib/snapshot-cache";

export function SnapshotCacheProvider({ scope, desktop, children }: {
  scope: string;
  desktop: { entries: SnapshotCacheEntry[] } | null;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const [restoring, setRestoring] = useState(true);
  useLayoutEffect(() => {
    let storage: Storage | undefined;
    let restored = desktop?.entries ?? [];
    if (!desktop) {
      try {
        storage = window.localStorage;
        const raw = storage.getItem(snapshotCacheStorageKey);
        restored = readSnapshotCache(raw, scope);
        if (raw && !restored.length) storage.removeItem(snapshotCacheStorageKey);
      } catch {
        storage = undefined;
      }
    }

    for (const { key, data, updatedAt } of restored) {
      if (updatedAt <= (client.getQueryState(key)?.dataUpdatedAt ?? 0)) continue;
      client.setQueryData(key, data, { updatedAt });
      // Preserve when the response was originally received, and revalidate on
      // mount even for immutable history keys whose normal stale time is infinite.
      void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
    }
    let active = true;
    queueMicrotask(() => { if (active) setRestoring(false); });
    if (!storage) return () => { active = false; };

    const entries = new Map(restored.map((entry) => [hashKey(entry.key), entry]));
    let timer: number | undefined;
    const flush = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      try {
        const existing = readSnapshotCache(storage.getItem(snapshotCacheStorageKey), scope);
        const packed = packSnapshotCache([...entries.values(), ...existing], scope);
        storage.setItem(snapshotCacheStorageKey, packed);
        entries.clear();
        for (const entry of readSnapshotCache(packed, scope)) entries.set(hashKey(entry.key), entry);
      } catch {
        // Storage may be disabled or full. The live query cache works as usual.
        entries.clear();
      }
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
      const { queryKey: key, state: { data, dataUpdatedAt: updatedAt } } = event.query;
      const entry = { key, data, updatedAt };
      if (!isSnapshotEntry(entry, Date.now())) return;
      entries.set(hashKey(key), entry);
      timer ??= window.setTimeout(flush, 250);
    });
    window.addEventListener("pagehide", flush);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [client, desktop, scope]);

  return <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>;
}
