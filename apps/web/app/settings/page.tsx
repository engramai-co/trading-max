import { Suspense } from "react";
import { SettingsWorkspace } from "@/workspace/settings";
import { Pending } from "@/workspace/foundation";
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <SettingsWorkspace localWorkspace={Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID)} />
    </Suspense>
  );
}
