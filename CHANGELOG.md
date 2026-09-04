# Changelog

All notable public Trading Max releases are recorded here.

## [Unreleased]

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
