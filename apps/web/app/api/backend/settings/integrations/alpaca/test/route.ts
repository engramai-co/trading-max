import { proxyJsonRequest } from "@/lib/backend-proxy";
export async function POST(request: Request) {
  return proxyJsonRequest("/v1/settings/integrations/alpaca/test", request, "POST");
}
