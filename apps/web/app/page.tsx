import { OverviewWorkspace } from "@/workspace/overview";
export const dynamic = "force-dynamic";
export default function Page() {
  return <OverviewWorkspace localWorkspace={Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID)} />;
}
