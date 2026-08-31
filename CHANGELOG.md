# Changelog

All notable public Trading Max releases are recorded here.

## [Unreleased]

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
