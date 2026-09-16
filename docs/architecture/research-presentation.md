# Research presentation

This document defines the current research interface. The [user guide](../guides/research.md)
explains how to use it; this page records its data and interaction boundaries.

## Navigation and chart responsibilities

- The company header displays a cached company logo with an accessible text
  identity and a fallback for unavailable images. The list pin belongs to the
  research-list heading, alongside list actions, and is absent on mobile.
- Overview retains a fixed three-month closing-price line preview. Price &
  technicals has three URL-addressable sections: price, technical data, and
  seasonality. Research event links explicitly return to the price section.
- The ordinary chart offers range, line/candles, volume and optional 20/50-bar
  averages. Advanced interval, axis, benchmark, RSI, MACD, average-period and
  zoom controls are in the full chart. Full-chart zoom is scoped to the security,
  range and interval; returning to the ordinary chart does not inherit an
  incompatible interval or benchmark comparison.
- Automatic security-price intervals are 15 minutes for 1D/5D, daily for
  1M–2Y/YTD, and weekly for all available history. Full charts reject 15-minute
  history beyond 1M and hourly history beyond 1Y/YTD. Provider fallback and
  incomplete coverage are visible. Portfolio ten-minute NAV sampling is an
  independent path and is unchanged.

## Financial charts and precision

- Large tooltip values use compact numbers; currency appears once. Exact values
  and filing provenance remain in keyboard-readable detail tables. Missing
  observations remain missing rather than becoming zero or interpolated prices.
- Business segments separate scale/composition (stacked amounts or shares) from
  individual segment trends. Stable, distinct colors identify the same segment
  across modes. Composition is shown only when segment totals reconcile; exact
  unreconciled observations remain accessible in details.
- Dividend history plots completed annual totals as a dot line, or trailing
  twelve-month totals. The current YTD is compared with the same prior-year
  cutoff separately. Future ex-dates and a truncated first year do not enter
  annual totals. A coverage flag distinguishes a complete short history from
  the provider's 120-event limit. This is provider-adjusted per-share cash, not
  a forward dividend estimate.
- Share-count views fit a linear axis to observed values and show line-end
  values. Period-end outstanding shares and diluted weighted-average shares
  are labelled distinctly; an alternative compares basic/diluted weighted
  shares for EPS. TTM uses four-quarter averages for weighted share counts and
  the last balance date for period-end shares. Their difference is not labelled
  dilution. Log scales are not imposed on all financial series.
- Operating margins stay separate from capital returns; financial statements
  retain annual/quarterly periods, original source rows and exact provenance.
  Forecasts continue to distinguish quarterly and annual periods.

## Technical data basis

The data section groups performance/location, momentum/trend, volatility and
volume/relative performance in one compact panel. It adds existing calculated
ADX, directional indices, stochastic K/D, Bollinger levels/width/location, ATR,
52-week range, volume averages and volume ratios to the typed snapshot boundary.
Values remain nullable and genuine zero values remain zero.

Technical indicators use completed daily bars, including exchange early-close
rules. A still-forming session is omitted; unknown exchange calendars
conservatively omit the current date. No OHLC bar is fabricated from a latest
quote. Latest option spot may still use the current genuine price independently.
Comparison readings use common observations and are restricted to matching
currency (the supplied SPY/QQQ/SOXX references are USD). Daily readings do not
pretend to track the live price in the company header.

## Valuation workflow

Operating references and scenario outputs precede assumption editing. The user
selects one assumption at a time, checks its source, changes it, and sees the
selected scenario update. Five- and ten-year horizons recompute through the same
preview API. Changes from the initial assumptions compare like horizons.
Sensitivity, worksheets and detailed evidence remain available as disclosures.

Parameter provenance distinguishes saved models, configured scenarios, sector
templates and user input. Model limitations belong with the basis details:
OCF minus capex is the equity cash-flow proxy used by this model, not a complete
FCFF enterprise-value bridge or a full net-borrowing-adjusted FCFE calculation.
Available cash/debt references do not imply that a bridge has been calculated.
The interface does not present a model output as a guaranteed fair price.

Saving a version captures assumptions, horizon, basis, references and an optional
reason together. Changing a saved model's horizon or inputs makes it saveable
again. Invalid intermediate number input cannot be submitted. Older saved
versions remain immutable and load without a reason.

## Compatibility, privacy and migration

New technical snapshot fields and model provenance are optional. Saved-model
reasons default to an empty string for existing records; no database migration
is required. OpenAPI and TypeScript contracts are generated together. Old
snapshots without dividend-coverage metadata use a conservative first-year rule.
Research stays on the real Yahoo-compatible and filing adapters; only the
existing Trading 212 preview ingestion is mocked. No new market-data mock is
introduced. Runtime snapshots, company-logo caches and private models stay outside Git.
Reviewed documentation screenshots use hypothetical broker inputs; personal
tutorials and operational screenshots stay outside the public repository.

## Validation

Unit coverage includes range/interval compatibility, incomplete price coverage,
annual/YTD/TTM dividend boundaries, truncated dividend histories, share-count
aggregation, nullable technical fields, completed sessions including early
closes, preview horizon/provenance and saved-model reason roundtrips.

Acceptance requires backend and frontend checks, a production build, and browser
checks of the three technical sections, simple/full chart controls, actual range
coverage, business modes, dividend/share presentation, model editing, list pin,
logo, keyboard interaction and narrow layouts. Browser verification uses an isolated broker-only preview. Write behavior is
tested in its disposable state, never in the user's production journal.
