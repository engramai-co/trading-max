import { HealthWorkspace } from "@/workspace/health";
export const dynamic = "force-dynamic";
export default function Page() {
  return <HealthWorkspace localWorkspace={Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID)} />;
}
