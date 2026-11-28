const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optionalAmount = (value: unknown) =>
  value == null || (typeof value === "number" && Number.isFinite(value));
const optionalString = (value: unknown) => value == null || typeof value === "string";
const timestamp = (value: unknown) =>
  typeof value === "string" && (value === "" || Number.isFinite(Date.parse(value)));

function rows(value: unknown, valid: (row: Record<string, unknown>) => boolean) {
  return value === undefined || (Array.isArray(value) && value.every((row) => record(row) && valid(row)));
}

const ticker = (row: Record<string, unknown>) => typeof row.ticker === "string";
const account = (row: Record<string, unknown>) =>
  typeof row.code === "string" && typeof row.isInvestable === "boolean" &&
  optionalAmount(row.totalValueGbp) && optionalAmount(row.cashGbp) && optionalAmount(row.unrealizedPnlGbp);

function attribution(value: unknown) {
  if (value == null) return true;
  if (!record(value) || typeof value.day !== "string") return false;
  return value.accounts === undefined || (record(value.accounts) && Object.values(value.accounts).every((row) =>
    record(row) && typeof row.since === "string" && typeof row.asOf === "string" &&
    rows(row.contributions, (contribution) => ticker(contribution) && typeof contribution.name === "string" &&
      typeof contribution.contributionGbp === "number" && Number.isFinite(contribution.contributionGbp))));
}

/** Check the fields Overview interprets. The service omits default empty collections. */
export function isOverviewSnapshot(value: unknown) {
  return record(value) && typeof value.runId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.runId) &&
    value.view === "overview" && timestamp(value.brokerAsOf) && timestamp(value.generatedAt) && timestamp(value.researchAsOf) &&
    optionalAmount(value.totalValueGbp) && optionalAmount(value.totalCashGbp) && optionalAmount(value.totalUnrealizedPnlGbp) &&
    rows(value.accounts, account) &&
    rows(value.holdings, (holding) => ticker(holding) && typeof holding.name === "string" &&
      (holding.account === "A" || holding.account === "B") &&
      optionalString(holding.dayChangeClosedOn) && optionalString(holding.dayChangeDate) &&
      (holding.priceCurrency === undefined || typeof holding.priceCurrency === "string")) &&
    rows(value.technical, ticker) && rows(value.valuations, ticker) &&
    attribution(value.dayAttribution) && attribution(value.windowAttribution);
}
