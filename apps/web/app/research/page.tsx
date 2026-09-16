import { Suspense } from "react";
import { ResearchWorkspace } from "@/workspace/research";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <ResearchWorkspace />
    </Suspense>
  );
}
