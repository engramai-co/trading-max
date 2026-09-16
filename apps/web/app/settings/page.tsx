import { Suspense } from "react";
import { SettingsWorkspace } from "@/workspace/settings";
import { Pending } from "@/workspace/foundation";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <SettingsWorkspace />
    </Suspense>
  );
}
