import { Suspense } from "react";
import { HoldingsWorkspace } from "@/workspace/holdings";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <HoldingsWorkspace />
    </Suspense>
  );
}
