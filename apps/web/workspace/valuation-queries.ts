import type { ResearchLensSnapshot } from "@/lib/types";
import { queryOptions, skipToken } from "@tanstack/react-query";
import { ApiError, api, jsonRequest } from "@/workspace/data";
import type { Preview, ScenarioInput } from "./research-facts";
import type { ResearchPrice } from "./research-price-basis";

const scenarios = ["bear", "base", "bull"] as const;

/** What a preview is computed from besides its basis. */
export type PreviewRequest = {
  scenarios: Record<string, ScenarioInput>;
  horizon: number;
  dataVersion: string;
  references: NonNullable<Preview["references"]>;
};

/** The request that reproduces a preview, optionally at another horizon. */
export function previewRequest(preview: Preview, horizon: number = preview.horizon): PreviewRequest {
  return {
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
  return JSON.stringify([preview.basis.ticker, preview.defaultSource ?? null, previewRequest(preview)]);
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
) {
  const parts = research(data);
  return queryOptions({
    queryKey: [
      "valuation-workbench",
      ...parts,
      spot ? [spot.source, spot.price, spot.asOf] : null,
    ],
    queryFn: async ({ client, signal }) => {
      const preview = await api<Preview>(
        `/research/${encodeURIComponent(data.ticker)}/valuation-preview`,
        { signal },
      );
      // A later refresh that fails keeps this one on screen.
      client.setQueryData(loadedValuationQuery(data).queryKey, preview);
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
export function loadedValuationQuery(data: ResearchLensSnapshot) {
  // Never fetched: each successful default preview writes it.
  return queryOptions<Preview>({
    queryKey: ["valuation-workbench", ...research(data), "loaded"],
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
        signal,
      }),
    staleTime: Infinity,
    retry: false,
  });
}
