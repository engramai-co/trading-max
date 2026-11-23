import { proxyDeleteRequest, proxyJsonRequest } from "@/lib/backend-proxy";

async function path(context: { params: Promise<{ profile: string }> }) {
  const { profile } = await context.params;
  return `/v1/settings/integrations/trading212/${encodeURIComponent(profile)}`;
}

export async function PUT(request: Request, context: { params: Promise<{ profile: string }> }) {
  return proxyJsonRequest(await path(context), request, "PUT");
}

export async function DELETE(request: Request, context: { params: Promise<{ profile: string }> }) {
  return proxyDeleteRequest(await path(context), request);
}
