"use client";

import { ArrowRight } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import Link from "@/workspace/link";

const focusRing =
  "rounded-sm outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]";

export interface TextLinkProps extends Omit<React.ComponentPropsWithoutRef<"a">, "href"> {
  href: string;
  /** Render a plain external anchor (`target="_blank" rel="noopener noreferrer"` by default). */
  external?: boolean;
  /** Inline link within body prose without the trailing navigation arrow or standalone block height. */
  inline?: boolean;
}

export const TextLink = React.forwardRef<HTMLAnchorElement, TextLinkProps>(function TextLink(
  { href, children, external, inline = false, className, target, rel, ...props },
  ref,
) {
  const isExternal = external ?? /^https?:\/\//.test(href);
  const classes = inline
    ? cn("text-link font-medium underline-offset-4 hover:underline", focusRing, className)
    : cn("mx-text-link", focusRing, className);

  if (isExternal) {
    return (
      <a
        ref={ref}
        href={href}
        target={target ?? "_blank"}
        rel={rel ?? "noopener noreferrer"}
        className={classes}
        {...props}
      >
        {children}
        {!inline && <ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" />}
      </a>
    );
  }

  return (
    <Link ref={ref} href={href} target={target} rel={rel} className={classes} {...props}>
      {children}
      {!inline && <ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" />}
    </Link>
  );
});
