# Changelog

All notable public Trading Max releases are recorded here.

## [Unreleased]

## [1.5.2] - 2026-09-19

### Fixed

- Backfill missed account-history dates from available market data, preserve
  identified broker observations, and retain reconciled cash flows when a
  same-day valuation is refreshed. Keep weekend observations on their actual
  dates and assign later cash movements to their actual valuation interval.
  Suppress returns and P&L across uncertain observation timing instead of
  recreating them in dashboard or review projections.
- Measure downside deviation against the return target so repeated equal
  losses do not incorrectly produce an unavailable Sortino ratio.
- Recover cancelled jobs after their worker lease expires, and keep scheduling
  services available when a fresh installation has no published snapshot yet.
- Diagnose bootstrap token mismatches, state-root isolation, source provenance
  and supported Node versions without claiming to have tested live providers.
  Keep schema inspection read-only and report its limits explicitly.
- Supervise all foreground processes and descendants, support linked Git
  worktrees in local service installation, and retain the selected Node path
  for launchd. Deployment readiness now requires a ready JSON result.
- Handle invalid watchlist/job requests, missing analysis resources and
  credential-store failures with controlled errors. Preserve exchange-qualified
  selections and refresh date-sensitive research and alert caches.
- Validate artifact provenance for binary reads and recover interrupted artifact
  metadata writes without changing stored content identities.
- Remove invalidated preview outputs before retries so a failed provider stage
  cannot republish stale results from an earlier checkpoint.
- Match semiannual financial comparisons to the same fiscal half, preserve
  period evidence in valuations, and keep missing filing facts unavailable.
- Use one common 20-session volume window and avoid options signals without
  usable open-interest or gamma evidence. Invalidate affected research caches.
- Validate security identifiers before replacing the durable catalog, reject
  non-finite CFD inputs and conflicting close adjustments, and normalize strict
  structured-output request schemas.

### Security

- Preserve credential isolation for custom installations, remove a secret-bearing
  command-line fallback, and redact validation failures on model-provider routes.
- Exclude environment-file variants from both backup paths, create private
  archives, and reject unsafe backup destinations and retention settings.

### Changed

- Refresh the onboarding skill, installation and diagnostic runbooks, provider
  notices and metric documentation against the current application behavior.
- Update README product screenshots from an isolated simulated broker portfolio
  using current provider data and the current portfolio P&L presentation.
- Align the example intraday retention with the 210-day default, and strengthen
  release gates for deployment checks and validated release tags.

## [1.5.1] - 2026-09-19

### Fixed

- Distribute compact portfolio-chart date labels evenly across the full timeline
  instead of sampling the already-reduced desktop labels a second time. Preserve
  the first and last date, year labels and aligned ticks across linked panels.

## [1.5.0] - 2026-09-18

### Added

- Select allocation-ring slices or category names to keep category, GBP value
  and percentage visible. Inspect grouped categories and use keyboard or touch
  selection across country, industry and GICS views.
- Extend the default intraday retention to 210 days for six-month history;
  reconstruct from available historical market bars while preserving original
  broker observations and genuine daily-only history.

### Changed

- Show cash-flow-adjusted period net P&L on the overview, sharing the detailed
  performance view's accounting basis and verified cutoff.
- Use fixed display intervals of 10 minutes, 30 minutes, one hour, two hours
  and four hours for 1D, 5D, 1M, 3M and 6M. YTD follows its elapsed span; 1Y
  and All display daily observations without reducing calculation precision.
- Give P&L and drawdown charts more height and eight date ticks on wide panels,
  with adaptive spacing on smaller screens.
- Show complete, wrapping allocation names alongside values; all allocation
  bar backgrounds represent 100%, including the largest category.

### Fixed

- Draw dashed connectors only across empty display buckets instead of every
  missed collection slot. Keep original gaps, source metadata and financial
  calculations intact without inventing observations.
- Keep chart fills visually continuous across gaps while suppressing readings
  on connector and fill layers; preserve exact records below the chart.

## [1.4.8] - 2026-09-18

### Fixed

- Keep date and year on separate lines in portfolio history axes so labels fit
  narrow overview cards and mobile screens. Preserve intraday clock labels,
  full timestamps in tooltips, and the shared overview/performance timeline.

## [1.4.7] - 2026-09-18

### Fixed

- Make the overview value chart a compact version of the performance value
  layer, using the same verified accounting cutoff, sampled observations,
  contribution steps, gap connections, tooltips, and exact-record display.
- Preserve account and period when opening performance from the overview;
  keep range choices in the URL across reloads and browser navigation.
- Keep value change distinct from cash-flow-adjusted profit/loss. Show the
  cumulative-contribution baseline at short and long ranges alike.
- Replace the dense coverage strip with a shared, expandable missing-record
  explanation while keeping pending cash-flow cutoffs visible.

## [1.4.6] - 2026-09-18

### Fixed

- Offer optional Alpaca historical SIP and BOATS prices to reduce stale US
  overnight marks during account reconstruction. Yahoo remains the default
  and fallback, including foreign securities and currency conversion.
- Add test-before-save Alpaca settings, reversible enhancement controls, and
  operating-system credential storage without returning keys to the browser.
- Respect delayed-data access, pagination, nominal prices, completed bars,
  exchange holidays and daylight saving. Bound overnight quote carry to ten
  minutes, retain real gaps, and preserve original broker observations.
- Record reconstruction feed coverage and fallback reasons in immutable
  provenance artifacts; reuse incremental caches outside the checkout.

## [1.4.5] - 2026-09-18

### Fixed

- Apply quote freshness from the actual market open, including pre/post-market
  sessions, without giving hourly prices an extra opening-hour grace period.
- Choose the newest completed observation across minute and hourly feeds before
  checking freshness. Keep the existing hourly fallback budget without reverting
  to an older price, and normalize pence consistently for hourly-only history.
- Carry closed-market prices only when the latest completed trading session has
  adequate quote coverage. Replace obsolete model results on a complete replay
  while retaining original broker observations and immutable source artifacts.

## [1.4.4] - 2026-09-17

### Fixed

- Draw missing portfolio observations as dashed endpoint connections without
  estimated values, filled areas or disconnected point markers. Keep hover
  readings tied to recorded observations in overview and performance charts.
- Advance reconciled cash-flow evidence with each live price update when ledger,
  cash and verified position quantities are unchanged. Preserve the last verified
  accounting cutoff when an actual account change needs reconciliation.
- Align value, contributions, profit/loss, drawdown and headline metrics to one
  cutoff; retain orange contribution steps and cash-flow changes at every range.

## [1.4.3] - 2026-09-17

### Fixed

- Stop inserting reconstructed valuations into missed broker collection slots
  after live history begins, preventing artificial spikes in account value,
  period profit/loss and drawdown. Retain earlier reconstructed history and all
  original broker and model evidence without adjusting their values.
- Connect real observations across collection gaps of at most 30 minutes without
  inventing intermediate samples. Preserve longer outages, unknown cash-flow
  values and accurate coverage records in both overview and performance charts.

## [1.4.2] - 2026-09-16

### Fixed

- Keep scheduled live account collection when a half-hour performance task
  reaches the queue first; retry a busy current slot without replaying old slots.
- Read only active jobs and the relevant schedule records for admission and
  status, avoiding repeated loading of thousands of completed jobs.
- Reuse schedule reads for legacy and current refresh-state fields and keep the
  reported next attempt aligned with deferred collection.

## [1.4.1] - 2026-09-16

### Changed
- Rebuild the README around the current portfolio and research workspace, with reviewed broker-only demonstration screenshots and direct installation and guide links.
- Add a documentation index and practical portfolio, research, valuation, options, and data-convention guides.
- Align architecture, privacy, and recovery documentation with unified cash-flow-aware P&L, independent research lenses, source coverage, and retained macOS releases.
- Replace internal iteration names and obsolete interface screenshots with documentation for the shipped 1.x product.

## [1.4.0] - 2026-09-16

### Added

- Extend technical readings with trend, volatility, volume and price-position measures, and add comparable basic/diluted weighted share counts.
- Save model rationale with assumptions and show the source of default scenarios while preserving older model versions.
- Link broker cash-flow evidence to intraday NAV and unify portfolio value, net flows and profit/loss across time ranges.
- Provide closed broker-trade fixtures for preview attribution without mocking market, FX or research data.

### Fixed

- Keep missing cash-flow evidence distinct from zero and align portfolio headlines with the calculations shown in charts and records.

## [1.3.9] - 2026-09-16

### Fixed

- Build macOS upgrades in independent release directories while the active app remains available.
- Retain complete installed runtimes and restore them on cutover failures without rebuilding or downloading dependencies.
- Preserve credentials during deployment, verify a consistent state backup, and cover additional dynamic routes in the production smoke check.
- Record interrupted deployments for explicit recovery and serialize host upgrades with a process lock.
- Retain the supported Node 22 executable per release, isolate Python build environments, and expand service paths safely.

## [1.3.8] - 2026-09-16

### Fixed

- Include years on multi-year timelines and keep intraday labels in the exchange timezone.
- Use consistent dates in axis labels and chart readings while keeping single-session axes compact.
- Dismiss chart readouts before their enclosing dialog and give help dialogs an explicit keyboard focus target.

## [1.3.7] - 2026-09-16

### Fixed

- Stabilize scenario comparisons against the current price and preserve their actual relative distances.
- Edit assumptions in percentage units, preserve intermediate input safely, and compare changes using the same horizon.
- Keep model saves tied to the submitted inputs and prevent stale previews from being saved during recalculation.

## [1.3.6] - 2026-09-16

### Fixed

- Keep overview focused on a three-month price line, with company logos and research-list pinning in context.
- Separate price charts, technical readings and seasonality into navigable sections.
- Keep advanced chart controls in the full chart and enforce valid interval/range combinations.

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
