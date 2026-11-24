"use client";

import { useLocalStorage } from "@/lib/hooks";
import { savedIndexKey } from "./market-indices-data";

const EMPTY_IDS: string[] = [];

/**
 * Indices in the research list. Stocks and funds live in the service's list;
 * indices stay in this browser's storage under the key they have always used.
 */
export function useListedIndices() {
  const [ids, setIds] = useLocalStorage<string[]>({ key: savedIndexKey, defaultValue: EMPTY_IDS });
  return {
    ids,
    has: (id: string) => ids.includes(id),
    add: (id: string) => setIds((items) => (items.includes(id) ? items : [...items, id])),
    remove: (id: string) => setIds((items) => items.filter((item) => item !== id)),
  };
}
