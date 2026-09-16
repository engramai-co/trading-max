import { Suspense } from "react";
import { AccountReviewWorkspace } from "@/workspace/review";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <AccountReviewWorkspace />
    </Suspense>
  );
}
