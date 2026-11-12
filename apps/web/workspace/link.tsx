"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { forwardRef, type ComponentProps } from "react";
import { useBuildNavigation } from "@/ui/publication-provider";
import { presentationLink } from "./desktop-routing";

// The same business components serve the browser and desktop presentation.
// Crossing a desktop surface uses a normal link, never a native IPC command.
const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(function WorkspaceLink(props, ref) {
  const pathname = usePathname();
  const navigateBuild = useBuildNavigation();
  const route = typeof props.href === "string" ? presentationLink(pathname, props.href) : null;
  return <NextLink {...props} ref={ref} href={route?.href ?? props.href}
    onNavigate={(event) => {
      let prevented = false;
      props.onNavigate?.({ preventDefault() { prevented = true; event.preventDefault(); } });
      if (!prevented && route && !route.separate && (!props.target || props.target === "_self")) {
        navigateBuild?.(route.href, event.preventDefault);
      }
    }}
    target={route?.separate ? "_blank" : props.target}
    rel={route?.separate ? "noopener" : props.rel} />;
});
export default Link;
