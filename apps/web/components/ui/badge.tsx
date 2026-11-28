"use client";

import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("mx-tag", {
  variants: {
    tone: { neutral: "mx-tag-neutral", good: "mx-tag-good", warn: "mx-tag-warn", bad: "mx-tag-bad" },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, render, ...props }: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    render,
    props: { ...props, className: cn(badgeVariants({ tone }), className) },
    state: { slot: "badge" },
  });
}
