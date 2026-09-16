import { Suspense } from "react";
import { PerformanceWorkspace } from "@/workspace/performance";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <PerformanceWorkspace />
    </Suspense>
  );
}
