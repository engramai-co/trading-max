"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { auxiliaryPage, desktopPage } from "./desktop-routing";
import { DesktopSurface } from "./desktop-surfaces";
import { LocalWorkspaceContext } from "./loading-context";
import { WorkspaceShell } from "./shell";

export function PresentationShell({ children, localWorkspace, demonstration }: { children: ReactNode; localWorkspace: boolean; demonstration: boolean }) {
  const pathname = usePathname();
  return <LocalWorkspaceContext.Provider value={localWorkspace}>
    {auxiliaryPage(pathname)
      ? <DesktopSurface localWorkspace={localWorkspace} demonstration={demonstration}>{children}</DesktopSurface>
      : <WorkspaceShell desktop={desktopPage(pathname) !== null} localWorkspace={localWorkspace}>{children}</WorkspaceShell>}
  </LocalWorkspaceContext.Provider>;
}
