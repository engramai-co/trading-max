import type { components } from "@/lib/api-schema";

type ApiSchemas = components["schemas"];
type Concrete<T> = T extends readonly (infer Item)[]
  ? Concrete<Item>[]
  : T extends object
    ? { [Key in keyof T]-?: Concrete<Exclude<T[Key], undefined>> }
    : T;

export type InvestableAccountCode = "A" | "B";
export type AccountCode = InvestableAccountCode | "C";

export type AccountSummary = ApiSchemas["AccountSummary"];

export type CfdSummary = ApiSchemas["CfdSummary"];
export type CfdImportStatus = Concrete<ApiSchemas["CfdImportStatus"]>;
export type AutomationSettings = Concrete<ApiSchemas["AutomationSettings"]> & {
  liveEnabled?: boolean;
  liveIntervalSeconds?: number;
  liveTimezone?: string;
  liveWeekdays?: number[];
  liveWindowEnd?: string;
  liveWindowStart?: string;
  performanceEnabled?: boolean;
  performanceIntervalSeconds?: number;
  performanceTimezone?: string;
  researchEnabled?: boolean;
  researchLocalTimes?: string[];
  researchTimezone?: string;
};

export type AccountAnalysisMetrics = ApiSchemas["AccountAnalysisMetrics"];
export type AccountReview = ApiSchemas["AccountReview"];
export type CfdAccountReview = ApiSchemas["CfdAccountReview"];
export type OverviewReviewSummary = ApiSchemas["OverviewReviewSummary"];

export type AccountReportRow = Record<string, unknown>;

export type AccountReportData = ApiSchemas["AccountReportData"];

export type Holding = ApiSchemas["Holding"];

export type NavPoint = ApiSchemas["NavPoint"];

export type RiskMetrics = ApiSchemas["RiskMetrics"];

export type TechnicalRow = ApiSchemas["TechnicalRow"];

export type PriceSeriesPoint = ApiSchemas["PriceSeriesPoint"];

export type ResearchTradeMarker = ApiSchemas["ResearchTradeMarker"];

export type BenchmarkPricePoint = ApiSchemas["BenchmarkPricePoint"];

export type ResearchPriceSeries = ApiSchemas["ResearchPriceSeries"];

export type OptionSnapshot = ApiSchemas["OptionSnapshot"];

export type ValuationRow = ApiSchemas["ValuationRow"];

export type ResearchShell = Concrete<ApiSchemas["ResearchShell"]>;

export type ResearchLensSnapshot = Concrete<ApiSchemas["ResearchLensSnapshot"]>;

export type ValuationScenarioInput = {
  revenueCagr: number | null;
  targetFcfMargin: number | null;
  discountRate: number | null;
  exitFcfMultiple: number | null;
  shareCagr: number | null;
};

export type ValuationCompanyAssumptions = {
  ticker: string;
  name: string;
  source: string;
  updatedAt: string | null;
  scenarios: Partial<
    Record<"bear" | "base" | "bull", Partial<ValuationScenarioInput>>
  >;
};

export type ValuationAssumptionsState = {
  schemaVersion: number;
  asOf: string;
  revision: number;
  companies: ValuationCompanyAssumptions[];
};

export type ValuationAssumptionsHistoryEntry = {
  entryId: string;
  ticker: string;
  name: string;
  source: string;
  revision: number;
  changedAt: string;
  changes: Record<
    string,
    { before: number | string | null; after: number | string | null }
  >;
};

export type LookthroughCountry = ApiSchemas["LookthroughCountry"];

export type LookthroughIndustry = ApiSchemas["LookthroughIndustry"];

export type LookthroughGicsSubIndustry =
  ApiSchemas["LookthroughGicsSubIndustry"];

export type LookthroughContributor = ApiSchemas["LookthroughContributor"];

export type LookthroughPosition = ApiSchemas["LookthroughPosition"];

export type LookthroughSource = ApiSchemas["LookthroughSource"];

export type LookthroughData = ApiSchemas["LookthroughData"];

export type DashboardData = ApiSchemas["DashboardResponse"];

export type DashboardLensName =
  | "overview"
  | "holdings-positions"
  | "holdings-lookthrough"
  | "analytics"
  | "review"
  | "account-analysis";

export type DashboardLens = ApiSchemas["DashboardLensSnapshot"];

type RefreshJobStage = Omit<
  Concrete<ApiSchemas["JobStageRecord"]>,
  "idempotencyKey"
> & {
  idempotencyKey?: string | null;
};

export type RefreshJob = Omit<
  Concrete<ApiSchemas["JobRecord"]>,
  "schemaVersion" | "stages"
> & {
  schemaVersion?: number;
  stages: RefreshJobStage[];
};

export type RefreshState = Omit<
  Concrete<ApiSchemas["RefreshState"]>,
  | "latestJob"
  | "latestFullJob"
  | "latestIntradayJob"
  | "nightly"
  | "intraday"
  | "live"
  | "performance"
  | "research"
> & {
  latestJob: RefreshJob | null;
  latestFullJob: RefreshJob | null;
  latestIntradayJob: RefreshJob | null;
  nightly: Omit<Concrete<ApiSchemas["NightlySchedule"]>, "lastJob"> & {
    lastJob: RefreshJob | null;
  };
  intraday: Omit<Concrete<ApiSchemas["IntradaySchedule"]>, "lastJob"> & {
    lastJob: RefreshJob | null;
  };
  live?: Omit<Concrete<ApiSchemas["IntradaySchedule"]>, "lastJob"> & {
    lastJob: RefreshJob | null;
  };
  performance?: Omit<Concrete<ApiSchemas["IntradaySchedule"]>, "lastJob"> & {
    lastJob: RefreshJob | null;
    materialChangeTriggered?: boolean;
  };
  research?: Omit<Concrete<ApiSchemas["NightlySchedule"]>, "lastJob"> & {
    lastJob: RefreshJob | null;
  };
};

/** Read-only metrics returned by the durable job queue health probes. */
export type HealthQueue = {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  last_success_at: string | null;
};

/** Read-only heartbeat information for the embedded or external worker. */
export type HealthWorker = {
  worker_id: string;
  status: string;
  started_at: string | null;
  last_seen_at: string | null;
  current_job_id: string | null;
  worker_version: string;
  pid: number | null;
  host: string | null;
  age_seconds: number | null;
  healthy: boolean;
};

export type HealthResponse = {
  status: "ok" | "degraded";
  service: string;
  latestRunId: string | null;
  bootstrapError: string | null;
  activeJobId: string | null;
  writeAuthEnabled: boolean;
  queue: HealthQueue;
  worker: HealthWorker | null;
  artifactAgeSeconds: number | null;
};

export type ReadinessResponse = {
  status: "ready" | "degraded" | "not_ready";
  service: string;
  latestRunId: string | null;
  bootstrapError: string | null;
  worker: HealthWorker | null;
  queue: HealthQueue;
};

export type HealthProbeScope =
  | "health"
  | "readiness"
  | "refresh"
  | "jobs"
  | "backend";

export type HealthProbeError = {
  scope: HealthProbeScope;
  status: number | null;
  detail: string;
};

export type JobListResponse = {
  jobs: RefreshJob[];
};

export type HealthDetails = {
  checkedAt: string;
  health: HealthResponse | null;
  readiness: ReadinessResponse | null;
  refresh: RefreshState | null;
  jobs: RefreshJob[];
  errors: HealthProbeError[];
};

export type ResearchFreshness = "fresh" | "aging" | "stale" | "unknown";

export type ResearchArtifactState = {
  key: string;
  kind: string;
  dataAsOf: string | null;
  generatedAt: string | null;
  ageDays: number | null;
  freshness: ResearchFreshness;
  sourceKind: string | null;
  modelVersion: string | null;
  warnings: string[];
};

export type ResearchStatus = {
  runId: string;
  generatedAt: string;
  overallFreshness: ResearchFreshness;
  artifacts: ResearchArtifactState[];
};

export type ResearchInstrument = {
  ticker: string;
  name: string;
  exchange: string;
  website: string;
  bloombergTicker: string;
  figi: string;
  categoryId: string;
  researchThemeId: string | null;
  taxonomyStatus?: "classifying" | "assigned" | "needs-review" | "unclassified";
  taxonomyLabelZh?: string | null;
  taxonomyLabelEn?: string | null;
  gics: GicsClassification | null;
  order: number;
  status: "pending" | "running" | "ready" | "partial" | "failed";
  lastRunId: string | null;
  lastError: string | null;
  hasMarket: boolean;
  hasTechnical: boolean;
  hasOptions: boolean;
  hasValuation: boolean;
  hasEarnings: boolean;
  hasFundamentals: boolean;
  held: boolean;
  exposureGbp: number;
};

export type WatchlistCategory = {
  id: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  order: number;
  taxonomy: "gics-sub-industry" | "research-theme" | "llm-taxonomy";
  code: string | null;
};

export type GicsClassification = {
  sectorCode: string;
  sectorName: string;
  industryGroupCode: string;
  industryGroupName: string;
  industryCode: string;
  industryName: string;
  subIndustryCode: string;
  subIndustryName: string;
  source: string;
  version: string;
  asOf: string;
  method: "official" | "derived" | "manual";
  confidence: number;
};

export type SecuritySearchResult = {
  ticker: string;
  name: string;
  exchange: string;
  bloombergTicker: string;
  figi: string;
  securityType: string | null;
  alreadyWatched: boolean;
};

export type SecuritySearchResponse = {
  query: string;
  source: "openfigi" | "watchlist";
  correctedQuery?: string | null;
  results: SecuritySearchResult[];
};

export type ResearchEvent = {
  ticker: string;
  asOf: string;
  eventType: string;
  title: string;
  summary: string | null;
  data: Record<string, unknown>;
  sources: Array<{ name: string; url: string }>;
};

export type ResearchAlert = {
  alertId: string;
  ticker: string;
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  asOf: string | null;
};

export type ResearchModelRun = {
  runId: string;
  generatedAt: string;
  dataAsOf: string | null;
  modelVersion: string | null;
  ticker: string;
  values: Record<string, unknown>;
  changes: Record<string, number | string | null>;
  dependencyHashes: Record<string, string>;
};

export type ResearchTimelinePoint = {
  runId: string;
  generatedAt: string;
  dataAsOf: string | null;
  technical: Record<string, unknown> | null;
  valuation: Record<string, unknown> | null;
  options: Record<string, unknown> | null;
};

export type PortfolioImpact = {
  ticker: string;
  totalValueGbp: number;
  directValueGbp: number;
  indirectValueGbp: number;
  exposureValueGbp: number;
  allocationPct: number;
  held: boolean;
  holdingAccounts: string[];
  country: string | null;
  industry: string | null;
  etfContributors: Array<Record<string, unknown>>;
};

export type ResearchTickerSnapshot = {
  ticker: string;
  runId: string;
  generatedAt: string;
  market: Record<string, unknown> | null;
  technical: Record<string, unknown> | null;
  valuation: Record<string, unknown> | null;
  options: Record<string, unknown> | null;
  fundamentals: Record<string, unknown> | null;
  analyst: Record<string, unknown> | null;
  financials: Record<string, unknown> | null;
  latestEvent: ResearchEvent | null;
  portfolioImpact: PortfolioImpact;
};

export type ResearchOverview = {
  status: ResearchStatus;
  watchlistCategories: WatchlistCategory[];
  instruments: ResearchInstrument[];
  fundamentals: Record<string, unknown>[];
  selected: ResearchTickerSnapshot | null;
  timeline: ResearchTimelinePoint[];
  events: ResearchEvent[];
  models: ResearchModelRun[];
  alerts: ResearchAlert[];
};

export type AnalysisPage =
  | "overview"
  | "holdings"
  | "analytics"
  | "research"
  | "technical"
  | "valuation"
  | "fundamentals"
  | "analyst"
  | "financials"
  | "options"
  | "ledger";

export type AnalysisLens =
  | "daily_cio_brief"
  | "hidden_exposure"
  | "return_attribution"
  | "watchlist_opportunity_map"
  | "technical_regime"
  | "valuation_scenario"
  | "fundamental_health"
  | "analyst_consensus"
  | "financial_statements"
  | "options_positioning"
  | "thesis_change";

export type LocalizedAnalysisText = {
  zh: string;
  en: string;
};

export type AnalysisEvidence = {
  label: LocalizedAnalysisText;
  detail: LocalizedAnalysisText;
  metric: string | null;
  sourceRefs: string[];
};

export type AnalysisArtifact = {
  schemaVersion: number;
  artifactId: string;
  analysisId: AnalysisLens;
  page: AnalysisPage;
  ticker: string | null;
  snapshotRunId: string;
  generatedAt: string;
  provider: string;
  model: string;
  route: string;
  adapter: string;
  providerRevision: number | null;
  routePolicyRevision: number | null;
  promptVersion: string;
  inputHash: string;
  confidence: number;
  content: {
    headline: LocalizedAnalysisText;
    summary: LocalizedAnalysisText;
    evidence: AnalysisEvidence[];
    counterpoints: LocalizedAnalysisText[];
    risks: LocalizedAnalysisText[];
    invalidationConditions: LocalizedAnalysisText[];
    nextObservations: LocalizedAnalysisText[];
    taxonomyAssignments?: Array<{
      ticker: string;
      themeId: string;
      confidence: number;
      rationale: LocalizedAnalysisText | null;
      createTheme?: boolean;
      themeLabelZh?: string | null;
      themeLabelEn?: string | null;
      themeDescriptionZh?: string | null;
      themeDescriptionEn?: string | null;
    }>;
  };
  sourceRefs: string[];
  usage: Record<string, number>;
  latencyMs: number;
  fake: boolean;
};

export type AnalysisRun = {
  schemaVersion: number;
  runId: string;
  snapshotRunId: string;
  trigger: "on_demand" | "nightly" | "snapshot";
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "interrupted";
  lenses: AnalysisLens[];
  ticker: string | null;
  provider: string;
  model: string;
  route: string;
  adapter: string;
  providerRevision: number | null;
  routePolicyRevision: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  artifactIds: string[];
  errors: string[];
  cached: boolean;
};

export type UserProfile = {
  profileId: string;
  displayName: string;
  initials: string;
  avatarColor: string;
  locale: "zh" | "en";
  baseCurrency: string;
  timezone: string;
  accountLabels: Record<string, string>;
  revision: number;
  updatedAt: string;
};

export type IntegrationSummary = {
  integrationId: string;
  provider: "trading212" | "deepseek" | "openai" | "opencode";
  profile: string | null;
  enabled: boolean;
  configured: boolean;
  model: string | null;
  baseUrl: string | null;
  credentialFingerprint: string | null;
  needsSecret: boolean;
  lastTestAt: string | null;
  lastTestStatus: "succeeded" | "failed" | "untested";
  lastErrorCode: string | null;
  revision: number;
  updatedAt: string;
};

export type LLMProvider = "opencode" | "deepseek";

export type LLMProviderDescriptor = {
  provider: LLMProvider;
  label: string;
  adapter: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
};

export type LLMRoutePolicy = {
  defaultRoute: string;
  overrides: Record<string, string>;
  revision: number;
  updatedAt: string;
};

export type IntegrationOverview = {
  deploymentMode: "personal_tailnet" | "local_workstation";
  profile: UserProfile;
  integrations: IntegrationSummary[];
  llmProviders: LLMProviderDescriptor[];
  llmRoutePolicy: LLMRoutePolicy | null;
};
