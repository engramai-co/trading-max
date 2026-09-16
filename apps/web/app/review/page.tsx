import { Suspense } from "react";
import { ReviewWorkspace } from "@/workspace/review";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <ReviewWorkspace />
    </Suspense>
  );
}
