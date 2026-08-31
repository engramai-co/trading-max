import { proxyJsonRequest } from "@/lib/backend-proxy";

export async function POST(request: Request, context: { params: Promise<{ profile: string }> }) {
  const { profile } = await context.params;
  return proxyJsonRequest(
    `/v1/settings/integrations/trading212/${encodeURIComponent(profile)}/test`,
    request,
    "POST",
  );
}
