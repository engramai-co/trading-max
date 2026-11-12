import type { Metadata } from "next";
import { Suspense } from "react";
import { Pending } from "@/workspace/foundation";
import { SectorsWorkspace } from "@/workspace/sectors";

export const metadata: Metadata = { title: "Markets" };

export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <SectorsWorkspace />
    </Suspense>
  );
}
