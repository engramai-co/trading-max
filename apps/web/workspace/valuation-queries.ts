import type { ResearchLensSnapshot } from "@/lib/types";
import type { components } from "@/lib/api-schema";
import { queryOptions, skipToken } from "@tanstack/react-query";
import { ApiError, api, jsonRequest } from "@/workspace/data";
import type { Preview, ScenarioInput } from "./research-facts";
import type { ResearchPrice } from "./research-price-basis";

const scenarios = ["bear", "base", "bull"] as const;
export type LockedInput = components["schemas"]["LockedInput"];
export type Maintenance = components["schemas"]["ValuationMaintenance"];

/** What a preview is computed from besides its basis. */
export type PreviewRequest = {
  family?: Preview["basis"]["family"];
  formulaVersion?: Preview["formulaVersion"];
  scenarios: Record<string, ScenarioInput>;
  horizon: number;
  dataVersion: string;
  references: NonNullable<Preview["references"]>;
};

/** The request that reproduces a preview, optionally at another horizon. */
export function previewRequest(preview: Preview, horizon: number = preview.horizon): PreviewRequest {
  return {
    family: preview.basis.family,
    formulaVersion: preview.formulaVersion,
    scenarios: Object.fromEntries(scenarios.map((key) => [key, preview.scenarios[key].inputs])),
    horizon,
    dataVersion: preview.basis.dataVersion,
    references: preview.references ?? [],
  };
}

/**
 * What resets the model editor: the research data and its default assumptions.
 * A new spot recomputes the scenarios but keeps the assumptions being edited.
 */
export function editorIdentity(preview: Preview) {
  return JSON.stringify([preview.basis.ticker, preview.defaultSource ?? null, preview.reverseMetric === "year-five-revenue" ? preview.id : previewRequest(preview)]);
}

/** One security's research data: what its default previews have in common. */
function research(data: ResearchLensSnapshot) {
  return [data.ticker, data.context?.quote.id ?? null, data.financialFacts?.version ?? null];
}

/**
 * A security's default valuation preview against the spot the page shows. A
 * new spot, such as a broker refresh, fetches it again; meanwhile the same
 * research's previous preview stays on screen, never another security's.
 */
export function valuationDefaultsQuery(
  data: ResearchLensSnapshot,
  spot?: Pick<ResearchPrice, "source" | "price" | "asOf"> | null,
  family?: Preview["basis"]["family"],
) {
  const parts = [...research(data), family ?? null];
  return queryOptions({
    queryKey: [
      "valuation-workbench",
      ...parts,
      spot ? [spot.source, spot.price, spot.asOf] : null,
    ],
    queryFn: async ({ client, signal }) => {
      const preview = await api<Preview>(
        `/research/${encodeURIComponent(data.ticker)}/valuation-preview${family ? "?family=" + family : ""}`,
        { signal, headers: { "x-valuation-contract": "2" } },
      );
      // A later refresh that fails keeps this one on screen.
      client.setQueryData(loadedValuationQuery(data, family).queryKey, preview);
      return preview;
    },
    // The service's refusals (incomplete inputs) are final; a dropped connection
    // while a broker refresh refetches is retried once.
    retry: (failures, error) => failures < 1 && !(error instanceof ApiError),
    placeholderData: (previous, query) =>
      query && parts.every((part, index) => query.queryKey[index + 1] === part)
        ? previous
        : undefined,
  });
}

/** The last default preview of this security's research that loaded, at any spot. */
export function loadedValuationQuery(data: ResearchLensSnapshot, family?: Preview["basis"]["family"]) {
  // Never fetched: each successful default preview writes it.
  return queryOptions<Preview>({
    queryKey: ["valuation-workbench", ...research(data), family ?? null, "loaded"],
    queryFn: skipToken,
  });
}

/**
 * What the valuation workbench shows. Once this research has a preview, the
 * editor stays on the latest one and a failed refresh is noted beside the
 * result; only before its first preview is a security pending or an error.
 */
export function workbenchState(
  current: { data?: Preview; isError: boolean },
  loaded: Preview | undefined,
) {
  const preview = current.data ?? loaded;
  if (preview) return { view: "editor" as const, preview, refreshFailed: current.isError };
  return current.isError ? { view: "error" as const } : { view: "pending" as const };
}

/**
 * Scenario inputs previewed on a default preview's basis, spot included, so a
 * new spot recomputes revisited assumptions instead of restoring old results.
 * The data version stays the research's: a broker refresh never rejects edits.
 */
export function valuationPreviewQuery(initial: Preview, request: PreviewRequest) {
  const { basis } = initial;
  return queryOptions({
    queryKey: [
      "valuation-preview",
      initial.id,
      [basis.spotSource, basis.spot, basis.spotAsOf],
      JSON.stringify(request),
    ],
    queryFn: ({ signal }) =>
      api<Preview>(`/research/${encodeURIComponent(basis.ticker)}/valuation-preview`, {
        ...jsonRequest("POST", request),
        headers: { "Content-Type": "application/json", "x-valuation-contract": "2" },
        signal,
      }),
    staleTime: Infinity,
    retry: false,
  });
}

/** Locks in one order, so equal sets compare and serialise alike. */
export function sortedLocks(locked: LockedInput[]) {
  const order = (lock: LockedInput) => lock.scenario + "." + lock.field;
  return [...new Map(locked.map((lock) => [order(lock), lock])).values()]
    .sort((a, b) => order(a).localeCompare(order(b)));
}

/**
 * How the saved version a reader started from moves to the proposal in the
 * editor: a deterministic comparison that never saves or contacts a model.
 * Each publication is compared afresh. While an edit is compared, the last
 * comparison stays on screen, but never one made with an earlier publication.
 */
export function valuationMaintenanceQuery(
  initial: Preview,
  modelId: string | undefined,
  request: PreviewRequest,
  locked: LockedInput[],
  publication: string | null | undefined,
  enabled: boolean,
) {
  const { basis } = initial;
  const run = publication ?? null;
  const body = {
    modelId,
    horizon: request.horizon,
    scenarios: request.scenarios,
    dataVersion: request.dataVersion,
    lockedInputs: sortedLocks(locked),
  };
  return queryOptions({
    queryKey: [
      "valuation-maintenance",
      basis.ticker,
      initial.id,
      run,
      [basis.spotSource, basis.spot, basis.spotAsOf],
      JSON.stringify(body),
    ],
    queryFn: ({ signal }) =>
      api<Maintenance>(`/research/${encodeURIComponent(basis.ticker)}/valuation-maintenance`, {
        ...jsonRequest("POST", body),
        signal,
      }),
    enabled: enabled && Boolean(modelId),
    staleTime: Infinity,
    retry: false,
    placeholderData: (previous, query) => (query?.queryKey[3] === run ? previous : undefined),
  });
}
