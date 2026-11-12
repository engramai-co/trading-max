"use client";

import { useState } from "react";

/** Capture complete results only. An error for a new key can still show the last complete result. */
export function useRetainedResult<T>(
  current: T | undefined,
  same: (current: T, previous: T) => boolean = Object.is,
  accept: (current: T, previous: T) => boolean = () => true,
) {
  const [last, setLast] = useState(current);
  if (current === undefined || last !== undefined && !accept(current, last)) return last;
  if (last === undefined || !same(current, last)) setLast(current);
  return current;
}
