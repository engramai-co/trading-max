# Changelog

All notable public Trading Max releases are recorded here.

## [Unreleased]

## [1.3.5] - 2026-09-16

### Fixed

- Format chart percentages and large amounts consistently, including accessible chart readings.
- Show annual dividends as a line and distinguish incomplete years from full-year totals.
- Improve business-segment comparisons and financial-history scales without hiding missing observations.

## [1.3.4] - 2026-09-16

### Fixed

- Reuse research and price requests across views, cancel obsolete navigation requests, and retain only matching security data during refresh.
- Cache immutable research evidence by revision and serve compact overview and document responses without unrelated calculations.
- Limit overview prices to their visible three-month window and expose actual history coverage and server timing.

## [1.3.3] - 2026-09-16

### Fixed

- Correct historical market sessions and technical calculations across exchange holidays and partial trading days.
- Preserve filing evidence and use split-consistent real price histories for research calculations.

## [1.3.2] - 2026-09-16

### Fixed

- Coalesce identical in-flight research and artifact reads without serializing
  unrelated securities behind a network lock. Bound cached entries and avoid
  retaining failed requests as successful results.
- Revalidate immutable artifact and snapshot files when their file metadata
  changes so a previous successful read cannot hide a replaced or corrupt file.

## [1.3.1] - 2026-09-16

### Fixed

- Match company names, tickers, and spelling variants against verified security
  identities. Rank exact and relevant matches ahead of unrelated fuzzy results,
  and show up to three meaningful candidates in the add-security dialog.
- Keep an existing company-name index usable during provider outages, refresh
  it using the correct clock, and bound identity lookups and cache lifetimes.
- Keep displayed search results aligned with the current submitted input;
  cancel obsolete requests and allow an explicit retry of the same search.

## [1.3.0] - 2026-09-16

### Added

- Add financial facts with annual, quarterly, and trailing periods, business
  and geographic segments, filing references, and comparability checks.
- Add independent research workflows for forecasts, analyst evidence, company
  events, options structure, fund exposure, valuation, and research notes.
- Add saved valuation models with source assumptions and financial context,
  plus research comparisons and evidence-linked financial views.
- Add price history and events, seasonality sample selection, exchange-aware
  calendars, and corporate-action context.

### Fixed

- Keep missing evidence and incomplete history visible rather than replacing
  them with fabricated figures, and show the selected seasonality sample.
- Preserve the previous release's security, reference-data packaging, and
  authoritative-classification fixes throughout the research expansion.

## [1.2.0] - 2026-09-16

### Added

- Rebuild the portfolio workspace with account summaries, holdings and ETF
  look-through, performance comparisons, account journals, and independent
  security research views.
- Reconstruct portfolio value on a ten-minute intraday timeline, including
  available extended-hours prices, and preserve collected broker observations.
- Add an isolated broker preview that uses synthetic Trading 212 inputs with
  real market, FX, benchmark, and research providers.
- Expand official Vanguard and iShares holdings adapters while preserving
  bonds, cash, derivatives, and issuer exposure.

### Changed

- Introduce a consistent blue visual identity, light and dark themes,
  bilingual navigation, responsive layouts, and keyboard support.
- Organize research by financial meaning, reduce repeated explanatory copy,
  and keep metric definitions and provenance available in context.
- Display 1D, 5D, 1M, and 3M charts at fixed ten-minute, thirty-minute,
  hourly, and two-hour intervals while retaining ten-minute source records.

### Fixed

- Include reference data once in backend wheels and source distributions so
  rebuilding an installation archive succeeds with current build tooling.
- Preserve official and manually reviewed industry classifications when an
  expired company profile is refreshed from a public market-data provider.
- Keep performance hover cards stable and theme-aware; join compatible broker
  and reconstructed observations without hiding genuine missing-data gaps.
- Preserve exchange-qualified securities, quote and statement currencies,
  financial units, and missing values across research and account views.
- Correct holdings sorting, analyst rating bands, period alignment, account
  history coverage, review units, and classification enrichment.
- Preserve newer settings drafts during saves, report validation failures,
  and restore focus after closing nested overlays.

### Security

- Update Next.js, image-processing and YAML dependencies to patched releases,
  and update the test runner to a supported patched release. Keep the existing
  read-only broker, external-state, and operating-system credential boundaries.

## [1.1.0] - 2026-09-04

### Changed

- Redesign the analyst lens around an interactive five-band recommendation
  consensus, rating trends, recent firm actions, and revenue and EPS forecasts.
- Pair the prior 12 months of actual prices with clearly labelled low, mean,
  and high reference rays for Yahoo's approximately 12-month targets, plus
  target summaries and point-level hover details.

### Fixed

- Remove the repeated research evidence date from the overview signal card;
  the page-level freshness status remains the single source of that context.

## [1.0.8] - 2026-09-04

### Fixed

- Align the overview's account-review and research-signal cards by moving the
  research evidence date into a quiet footer beneath the signal rows.

## [1.0.7] - 2026-09-03

### Fixed

- Prefer the current typed market snapshot throughout the research workbench
  and freshness status, while retaining legacy market data only as a fallback.
- Compare account TWR with auto-adjusted VOO, QQQ, and VT series translated
  into GBP, and calculate VOO benchmark return and information ratio over the
  account's aligned daily valuation intervals.

## [1.0.6] - 2026-09-03

### Added

- Restore optional OpenCode and direct DeepSeek connections in Settings for
  fuzzy security search, automatic classification, and research summaries.

### Changed

- Keep account, market, and deterministic identity sources ahead of model use,
  and fall back to the other configured approved model service before an
  optional research request begins.
- Allow either OpenCode or direct DeepSeek to perform the final bounded entity
  resolution step with one web search, while preserving full operation without
  any model credentials.

## [1.0.5] - 2026-09-02

### Fixed

- Distinguish selected-period and cumulative net P&L in money-chart tooltips,
  keeping range-relative performance intact while making carried CFD results
  visible in the all-account context.

## [1.0.4] - 2026-09-01

### Changed

- Preserve real B, S, and T fill markers for previously held securities while
  they remain in the research watchlist, without adding historical tickers to
  the watchlist automatically.

## [1.0.3] - 2026-09-01

### Added

- Mark real Trading 212 fill days on held-security candlestick charts as B
  (buy only), S (sell only), or T (both directions), with account, order,
  quantity, and weighted-average fill details on hover.

### Fixed

- Keep the research overview candlestick chart fixed to its labelled one-month
  window while reserving draggable history for the dedicated technical view.

## [1.0.2] - 2026-09-01

### Added

- Make the research workbench's technical candlestick chart horizontally
  draggable, so shorter ranges can browse earlier sessions without refetching
  data or driving React updates during the gesture.

## [1.0.1] - 2026-09-01

### Fixed

- Render allocations, weights, shares, rates, volatility, margins, and other
  level percentages without a leading plus sign, while preserving explicit
  positive and negative signs for returns, P&L, drawdowns, growth, and other
  directional changes.

## [1.0.0] - 2026-09-01

### Added

- First public release of the local-first Trading Max portfolio application.
- Added read-only Trading 212 Invest and Stocks ISA ingestion, immutable
  snapshots, cash-flow-aware performance, ETF look-through, Security Master,
  GICS classification, and per-ticker research lenses.
- Added a responsive bilingual Next.js interface backed by FastAPI, durable
  refresh jobs, health/readiness views, backups, and safe restore.
- Added OS credential-store-backed integration settings and an agent-owned
  local onboarding flow that keeps credentials out of chat, files, and logs.
- Added Apache-2.0 licensing, provider attribution, governance, contribution,
  security, privacy, support, and release checks.
- Enforce one SemVer increment and one dated changelog release on every pull
  request, then create an annotated tag and dispatch the complete source
  release pipeline after the protected main-branch CI succeeds.

### Fixed

- Connect internal collection gaps in the overview broker-value chart with
  dashed evidence bridges while keeping leading, trailing, and observed
  intervals visually distinct.
- Resolve historical prices by exact ISIN cross-listing and quote currency,
  preventing sparse broker trade prices from concentrating multi-day returns
  into a false jump on the next trade date.
- Fail historical NAV reconstruction when a held security lacks market prices
  instead of silently carrying a transaction price across unpriced dates.
