# Research presentation revision — September 2026

## Status and motivation

This records the current local implementation, not product-design acceptance.
The product owner requested completion of this iteration followed by a separate,
read-only comparative audit against TradingView and Stock Analysis.

The previous research workspace repeatedly used horizontal bars for unrelated
metrics. It also connected quarterly and annual forecasts, mixed operating
margins with capital returns, and reduced report readability by keeping provider
field order. The revision preserves all eight research lenses and their APIs.

## Presentation decisions

- The research list opens in a drawer, giving the selected security the full
  content width. Search, category filters, held-only filtering, add, update and
  removal safeguards remain available.
- Company context reuses the fundamentals lens. Technical levels use a table
  with prices and deviations; momentum readings remain separate. Monthly
  seasonality uses the available month aggregates, with mean/median selection
  and sample counts. No year-by-year series is fabricated from those aggregates.
- Scenario valuations use price-position dots and an assumptions table.
  Sensitivity curves use actual input values and a shared value scale. They are
  explicitly five-year results: the service does not provide ten-year
  sensitivity. Implied growth similarly uses the five-year model; solver bounds
  are displayed as bounds rather than sentinel values.
- Operating amounts and margins have separate views. Margins, return on equity
  and return on assets are not put on one comparison axis. Financial statements
  start with principal line items in financial order; all source rows remain
  searchable, with full detail, annual/quarterly periods, unit selection and
  optional period changes.
- Analyst earnings and revenue estimates separate quarterly and annual
  periods. Ranges, year-ago values, growth and analyst counts remain available.
  Historical ratings and earnings results retain charts with exact details.
  An absent or nonpositive target price is not presented as a zero-dollar target.
- The near-money option chain pairs calls and puts around strike. Expiration
  selection precedes dependent values. Time to expiry is labelled relative to
  the snapshot; gamma explicitly uses all covered expirations. Open interest,
  gamma and the complete contract table remain available.
- Research observations retain their actual severity. Small model histories
  use an exact table; longer histories are separated by currency before plotting.

## Alternatives and limits

A blanket swap from bars to lines would preserve the underlying problems.
Operating period totals, recommendation counts and open-interest distributions
still use bars where magnitude or composition is meaningful. The revision does
not claim parity with either reference product: interactive valuation
recalculation, richer price studies, segment histories and research provenance
require the separate audit to establish scope and data requirements.

## Compatibility, privacy and migration

No API, schema, provider or database migration is required. Broker data in the
existing preview is synthetic; research and market data continue through the
real Yahoo-compatible adapter. Runtime snapshots and screenshots stay outside
Git. No credentials, account state or remote source deployment are modified by
the presentation change. Reverting the frontend commit restores presentation
without rolling back data.

## Validation

Frontend tests cover forecast grouping, missing sensitivity samples, statement
ordering, reference-price validity and implied-growth bounds, alongside existing
financial, chart and bilingual tests. Type checking, lint, architecture/API type
checks and the production build are required. Browser verification covers eight
lenses, drawer navigation, forecast periods, statement search and detail controls,
model horizons, theme/language switching, mobile layout and fund applicability.
Saving assumptions and refreshing external research are intentionally not invoked
in the shared preview during read-only browser verification.
