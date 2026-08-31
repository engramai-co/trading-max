export function researchLensQueryKey(
  runId: string,
  ticker: string,
  view: string,
  mock: boolean,
  locale?: "zh" | "en",
) {
  return [
    "research-lens",
    runId,
    ticker,
    view,
    mock ? locale ?? "zh" : null,
    mock,
  ] as const;
}

export function researchPricesQueryKey(
  runId: string,
  ticker: string,
  mock: boolean,
) {
  return ["research-prices", runId, ticker, mock] as const;
}
