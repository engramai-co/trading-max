import { citedEventKind } from "@/lib/cited-calendar-event";
import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{runId: string}> }) {
  const {runId} = await context.params;
  const query = new URL(request.url).searchParams;
  const ticker = query.get("ticker") ?? "";
  const kind = query.get("kind") ?? "";
  const event = query.get("eventId");
  const researchEvent = query.get("researchEventId");
  // Only a single identity is forwarded. Dates, scopes and pagination belong to the calendar list.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId) || !/^[A-Za-z0-9^=._-]{1,32}$/.test(ticker) ||
      citedEventKind(kind) !== kind || query.size !== 3 ||
      !(event ? /^ev_[A-Za-z0-9_-]{1,96}$/.test(event) : /^[A-Za-z0-9._:-]{1,128}$/.test(researchEvent ?? ""))) {
    return privateJsonResponse({detail:"A cited ticker and event identity are required"}, {status:400});
  }
  const selected = new URLSearchParams({ticker, kind});
  if (event) selected.set("event_id", event);
  else selected.set("research_event_id", researchEvent!);
  return proxyToBackend(`/v1/snapshots/${runId}/events/cited?${selected}`, {signal:request.signal});
}
