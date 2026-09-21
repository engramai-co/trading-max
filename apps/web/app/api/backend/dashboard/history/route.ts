import { privateJsonResponse } from "@/lib/backend-proxy";
import { HistoryRequestError, readPreparedHistory } from "@/lib/history-server";
import { PORTFOLIO_RANGES } from "@/lib/portfolio/history";
import { historyPage, type HistorySelection } from "@/lib/portfolio/prepared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const runId = params.get("runId") ?? "";
  const range = params.get("range") ?? "3M";
  const scope = params.get("scope") ?? "total";
  const page = params.get("page");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)
    || !PORTFOLIO_RANGES.some((value) => value === range)
    || !["invest", "isa", "total", "household", "cfd"].includes(scope)
    || (page != null && (!/^[1-9]\d{0,6}$/.test(page)))) {
    return privateJsonResponse(request, { detail: "Invalid history selection" }, { status: 400 });
  }
  try {
    const prepared = await readPreparedHistory({ runId, range, scope } as HistorySelection);
    return privateJsonResponse(request, page == null ? prepared.chart : historyPage(prepared, Number(page)));
  } catch (error) {
    return privateJsonResponse(request, { detail: "History could not be loaded. Please retry." },
      { status: error instanceof HistoryRequestError ? error.status : 503 });
  }
}
