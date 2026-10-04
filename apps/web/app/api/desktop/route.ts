export function GET() {
  return Response.json({ service: "trading-max-web", desktopPresentation: 1 }, { headers: { "Cache-Control": "no-store" } });
}
