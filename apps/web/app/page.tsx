import { Suspense } from "react";
import { OverviewWorkspace } from "@/workspace/overview";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <OverviewWorkspace />
    </Suspense>
  );
}
