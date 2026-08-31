"use client";

import { Skeleton, Stack } from "@mantine/core";
import type { CSSProperties } from "react";

/**
 * Adds a short, local-only "fetch" pause to synthetic previews.
 *
 * A stable skeleton owns the first paint, then yields to the complete mock in
 * one short transition so the preview behaves like a real data boundary.
 */
export function LocalMockReveal({
  children,
  delayMs = 420,
}: {
  children: React.ReactNode;
  delayMs?: number;
}) {
  const delay = Math.max(0, Math.min(delayMs, 2_000));

  return (
    <div
      className="tm-local-mock-reveal"
      style={{ "--tm-mock-delay": `${delay}ms` } as CSSProperties}
    >
      <div className="tm-local-mock-content">
        {children}
      </div>
      <div aria-hidden="true" className="tm-local-mock-skeleton">
        <Stack gap="sm" p="md">
          <Skeleton height={18} width="36%" />
          <Skeleton height={32} width="62%" />
          <Skeleton height={150} />
        </Stack>
      </div>
    </div>
  );
}
