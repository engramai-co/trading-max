import { Suspense } from "react";
import { Pending } from "@/workspace/foundation";
import { SectorsWorkspace } from "@/workspace/sectors";

export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <SectorsWorkspace />
    </Suspense>
  );
}
