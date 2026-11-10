import type { ReactNode } from "react";

// Remove only the unused space to the right of each mark, leaving the
// visible glyph and a Han character's typical left bearing (PingFang SC).
const endMargins: Record<string, number> = {
  "，": -0.67,
  "。": -0.57,
  "、": -0.57,
  "！": -0.63,
  "？": -0.48,
  "：": -0.63,
  "；": -0.62,
  "）": -0.63,
  "」": -0.6,
  "』": -0.6,
};

export function CenteredCopy({ children }: { children: ReactNode }) {
  if (typeof children !== "string") return children;

  const mark = children.slice(-1);
  const margin = endMargins[mark];
  if (margin === undefined) return children;

  const beforeMark = children.slice(0, -1);
  const tail = beforeMark.match(/\S\p{Mark}*$/u);
  if (!tail) return children;

  return (
    <>
      {beforeMark.slice(0, tail.index)}
      <span className="mx-centered-copy-tail">
        {tail[0]}
        <span style={{ marginInlineEnd: `${margin}em` }}>{mark}</span>
      </span>
    </>
  );
}
