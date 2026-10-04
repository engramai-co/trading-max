"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { forwardRef, type ComponentProps } from "react";
import { presentationLink } from "./desktop-routing";

// The same business components serve the browser and desktop presentation.
// Crossing a desktop surface uses a normal link, never a native IPC command.
const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(function WorkspaceLink(props, ref) {
  const pathname = usePathname();
  const route = typeof props.href === "string" ? presentationLink(pathname, props.href) : null;
  return <NextLink {...props} ref={ref} href={route?.href ?? props.href}
    target={route?.separate ? "_blank" : props.target}
    rel={route?.separate ? "noopener" : props.rel} />;
});
export default Link;
