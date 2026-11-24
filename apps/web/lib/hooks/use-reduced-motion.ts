"use client";

import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useMediaQuery } from "./use-media-query";

export function useReducedMotion(initialValue = false): boolean {
  return useMediaQuery(MEDIA_QUERIES.reducedMotion, initialValue);
}
