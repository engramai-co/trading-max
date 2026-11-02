"use client";

/** Tiny inline trends. They carry shape only; exact values stay in the table or tooltip beside them. */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => [
    (index / (values.length - 1)) * 100,
    30 - ((value - min) / span) * 28,
  ]);
  const line = points.map(([x, y], index) => (index ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2)).join("");
  return (
    <svg className={"mx-sparkline " + className} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <path className="mx-sparkline-area" d={line + "L100 32L0 32Z"} />
      <path className="mx-sparkline-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Oldest to newest, left to right; the latest period is solid and losses drop below the baseline. */
export function Sparkbars({ values }: { values: (number | null | undefined)[] }) {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (finite.length < 2) return null;
  const max = Math.max(0, ...finite);
  const span = max - Math.min(0, ...finite) || 1;
  const baseline = (max / span) * 18;
  // Fixed-width slots keep bars thin whether a statement has two periods or ten.
  const slot = 8;
  const width = values.length * slot;
  return (
    <svg className="mx-sparkbars" viewBox={`0 0 ${width} 18`} width={width} height="18" aria-hidden="true">
      {values.map((value, index) => {
        if (value == null || !Number.isFinite(value)) return null;
        const height = Math.max(1, (Math.abs(value) / span) * 18);
        return (
          <rect
            key={index}
            x={index * slot + 1.5}
            y={value >= 0 ? baseline - height : baseline}
            width={5}
            height={height}
            rx={1}
            data-latest={index === values.length - 1 || undefined}
            data-negative={value < 0 || undefined}
          />
        );
      })}
    </svg>
  );
}
