/** A box as getBoundingClientRect reports it. */
export type IndicatorBox = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

/** Numeric indicator placement relative to its host list. */
export type IndicatorTarget = { x: number; y: number; width: number; height: number };

/**
 * True when a newly measured indicator box matches the cached numeric target within
 * subpixel tolerance, avoiding CSSOM string-serialisation mismatches.
 */
export function sameIndicatorTarget(
  previous: IndicatorTarget | null,
  next: IndicatorTarget,
  tolerance = 0.5,
) {
  return (
    previous !== null &&
    Math.abs(previous.x - next.x) < tolerance &&
    Math.abs(previous.y - next.y) < tolerance &&
    Math.abs(previous.width - next.width) < tolerance &&
    Math.abs(previous.height - next.height) < tolerance
  );
}

/**
 * The first frame of a sliding indicator's FLIP move: its target translation plus
 * the distance from the box it now has back to the box it had, scaled from its
 * top-left corner to its former size. Both boxes are measured on screen, so the
 * indicator's own anchor cancels out: an underline anchored to the bottom of its
 * tabs starts level with them. Null when nothing would visibly move.
 */
export function indicatorStart(from: IndicatorBox, to: IndicatorBox, target: { x: number; y: number }) {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (!to.width || !to.height) return null;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(from.width - to.width) < 0.5) return null;
  return "translate(" + (target.x + dx) + "px, " + (target.y + dy) + "px) scale("
    + from.width / to.width + ", " + from.height / to.height + ")";
}
