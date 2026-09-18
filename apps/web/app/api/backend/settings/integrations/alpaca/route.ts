import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

const path = "/v1/settings/integrations/alpaca";
export async function PUT(request: Request) { return proxyJsonRequest(path, request, "PUT"); }
export async function PATCH(request: Request) { return proxyJsonRequest(path, request, "PATCH"); }
export async function DELETE() { return proxyToBackend(path, { method: "DELETE" }); }
