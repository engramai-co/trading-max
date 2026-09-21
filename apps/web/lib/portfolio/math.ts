/** Missing observations stay missing; they never reset the previous high. */
export function drawdowns(
  values: Array<number | null>,
  compounded = false,
): Array<number | null> {
  let high: number | null = null;
  return values.map((value) => {
    if (value == null || !Number.isFinite(value)) return null;
    high = high == null ? value : Math.max(high, value);
    return compounded
      ? high <= -1
        ? null
        : (1 + value) / (1 + high) - 1
      : value - high;
  });
}

export function minimumObserved(values: Array<number | null>) {
  const valid = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  return valid.length ? Math.min(...valid) : null;
}
