"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { auxiliaryPage, desktopPage } from "./desktop-routing";
import { DesktopSurface } from "./desktop-surfaces";
import { WorkspaceShell } from "./shell";

export function PresentationShell({ children, localWorkspace, demonstration }: { children: ReactNode; localWorkspace: boolean; demonstration: boolean }) {
  const pathname = usePathname();
  if (auxiliaryPage(pathname)) return <DesktopSurface localWorkspace={localWorkspace} demonstration={demonstration}>{children}</DesktopSurface>;
  return <WorkspaceShell desktop={desktopPage(pathname) !== null}>{children}</WorkspaceShell>;
}
