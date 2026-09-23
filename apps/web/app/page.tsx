import { Suspense } from "react";
import { OverviewWorkspace } from "@/workspace/overview";
import { Pending } from "@/workspace/foundation";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <OverviewWorkspace localWorkspace={Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID)} />
    </Suspense>
  );
}
