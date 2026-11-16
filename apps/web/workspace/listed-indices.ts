"use client";

import { useLocalStorage } from "@mantine/hooks";
import { savedIndexKey } from "./market-indices-data";

/**
 * Indices in the research list. Stocks and funds live in the service's list;
 * indices stay in this browser's storage under the key they have always used.
 */
export function useListedIndices() {
  const [ids, setIds] = useLocalStorage<string[]>({ key: savedIndexKey, defaultValue: [] });
  return {
    ids,
    has: (id: string) => ids.includes(id),
    add: (id: string) => setIds((items) => (items.includes(id) ? items : [...items, id])),
    remove: (id: string) => setIds((items) => items.filter((item) => item !== id)),
  };
}
