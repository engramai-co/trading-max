import {
  PRIVATE_JSON_HEADERS,
  proxyRawRequest,
  proxyToBackend,
  validateWriteRequest,
} from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

const CFD_CSV_MEDIA_TYPES = [
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
] as const;

export async function GET() {
  return proxyToBackend("/v1/imports/trading212/cfd");
}

export async function POST(request: Request) {
  const rejected = validateWriteRequest(request, { allowedMediaTypes: CFD_CSV_MEDIA_TYPES });
  if (rejected) return rejected;
  const filename = request.headers.get("x-trading-max-filename");
  if (!filename) {
    return Response.json(
      { detail: { code: "cfd_filename_required", message: "A source filename is required" } },
      { status: 422, headers: PRIVATE_JSON_HEADERS },
    );
  }
  return proxyRawRequest(
    "/v1/imports/trading212/cfd",
    request,
    "POST",
    {
      "Content-Type": request.headers.get("content-type") ?? "text/csv",
      "X-Trading-Max-Filename": filename,
    },
    undefined,
    CFD_CSV_MEDIA_TYPES,
  );
}
