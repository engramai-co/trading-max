"use client";

import { useMediaQuery } from "@mantine/hooks";
import { createContext, useContext, type ReactNode } from "react";

const FinePointer = createContext(false);

/**
 * One subscription for the whole app. Hover-only UI reads it from context, so a
 * pointer change (a trackpad attached to a tablet, a device-mode switch) is one
 * update rather than one per table row.
 */
export function FinePointerProvider({ children }: { children: ReactNode }) {
  const fine = useMediaQuery("(hover: hover) and (pointer: fine)");
  return <FinePointer.Provider value={fine}>{children}</FinePointer.Provider>;
}

export function useFinePointer() {
  return useContext(FinePointer);
}
