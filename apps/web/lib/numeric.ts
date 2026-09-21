/** Parse a finite numeric value without treating missing inputs as zero. */
export const numeric = (value: unknown): number | null =>
  (typeof value !== "number" && typeof value !== "string") ||
  (typeof value === "string" && value.trim() === "")
    ? null
    : Number.isFinite(Number(value))
      ? Number(value) || 0
      : null;
