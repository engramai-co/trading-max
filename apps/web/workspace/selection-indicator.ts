/** A box as getBoundingClientRect reports it. */
export type IndicatorBox = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

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
