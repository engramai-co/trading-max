import { portfolioHistoryKey } from "@/lib/dashboard-query";
import { rememberDesktopSnapshot } from "@/lib/snapshot-cache-server";
import { privateJsonResponse } from "@/lib/backend-proxy";
import { HistoryRequestError, readPreparedHistory } from "@/lib/history-server";
import { PORTFOLIO_RANGES } from "@/lib/portfolio/history";
import { exactInstant, historyPage, pnlsAt, type HistorySelection } from "@/lib/portfolio/prepared";

export const dynamic = "force-dynamic";

/** At most one opening per investable account. */
const MAX_OPENINGS = 2;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const runId = params.get("runId") ?? "";
  const range = params.get("range") ?? "3M";
  const scope = params.get("scope") ?? "total";
  const page = params.get("page");
  // A chart request may name the openings of the attributions it explains, each an
  // exact instant with its offset, so no answer depends on the server's time zone.
  const openings = params.getAll("opening");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)
    || !PORTFOLIO_RANGES.some((value) => value === range)
    || !["invest", "isa", "total", "household", "cfd"].includes(scope)
    || (page != null && (!/^[1-9]\d{0,6}$/.test(page) || openings.length > 0))
    || openings.length > MAX_OPENINGS
    || openings.some((at) => exactInstant(at) == null)) {
    return privateJsonResponse(request, { detail: "Invalid history selection" }, { status: 400 });
  }
  try {
    const selection = { runId, range, scope } as HistorySelection;
    const prepared = await readPreparedHistory(selection);
    if (page != null) return privateJsonResponse(request, historyPage(prepared, Number(page)));
    const chart = openings.length ? { ...prepared.chart, openings: pnlsAt(prepared, openings) } : prepared.chart;
    rememberDesktopSnapshot(portfolioHistoryKey(selection, openings), chart);
    return privateJsonResponse(request, chart);
  } catch (error) {
    return privateJsonResponse(request, { detail: "History could not be loaded. Please retry." },
      { status: error instanceof HistoryRequestError ? error.status : 503 });
  }
}
