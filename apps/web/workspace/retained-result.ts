"use client";

import { useState } from "react";

/** Capture complete results only. An error for a new key can still show the last complete result. */
export function useRetainedResult<T>(
  current: T | undefined,
  same: (current: T, previous: T) => boolean = Object.is,
) {
  const [last, setLast] = useState(current);
  if (current !== undefined && (last === undefined || !same(current, last))) setLast(current);
  return current ?? last;
}
