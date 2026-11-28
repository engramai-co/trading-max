import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type CardProps = ComponentPropsWithoutRef<"article"> & {
  as?: "article" | "section" | "div";
  /** Use a plain root where a rule or an existing surface already groups the content. */
  appearance?: "panel" | "plain";
};

export function Card({ as: Root = "article", appearance = "panel", className, ...props }: CardProps) {
  return <Root data-slot="card" className={cn(appearance === "panel" && "mx-panel", className)} {...props} />;
}
