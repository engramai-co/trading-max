import { proxyRawRequest, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyToBackend("/v1/imports/trading212/cfd");
}

export async function POST(request: Request) {
  const filename = request.headers.get("x-trading-max-filename");
  if (!filename) {
    return Response.json(
      { detail: { code: "cfd_filename_required", message: "A source filename is required" } },
      { status: 422 },
    );
  }
  return proxyRawRequest(
    "/v1/imports/trading212/cfd",
    request,
    "POST",
    {
      "Content-Type": request.headers.get("content-type") || "text/csv",
      "X-Trading-Max-Filename": filename,
    },
  );
}
