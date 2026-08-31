# Valuation engine v3 (superseded)

This design is superseded by [`valuation-v4.md`](valuation-v4.md). V3 is kept
only as a historical record; its displayed exit-multiple assumptions were not
passed into the calculation, and its one-size-fits-all cash-flow semantics must
not be restored.

## Purpose

`research.valuation` (valuation-v3) values growth companies through an explicit
bull / base / bear scenario engine instead of a single deterministic DCF. It
is designed for a portfolio concentrated in semiconductors, AI infrastructure,
software, and pre-profit growth names, where a fixed-discount, constant-margin
DCF produces misleading single numbers.

## Inputs

- `research/technical.json` — spot price from the immutable market snapshot.
- `research/fundamentals.json` — yfinance-normalized metrics (revenue, FCF,
  debt, cash, shares, beta, analyst targets, sector/industry).
- `research/valuation_assumptions.json` — optional legacy manual scenarios.
  Per-ticker `scenarios` (`bear` / `base` / `bull`) override sector-template
  defaults when present.
- FX loader — converts report-currency financials (`financialCurrency`) to the
  quote currency when they differ; the model fails loudly rather than mixing
  currencies.

## Scenario construction

Each scenario contains:

- `revenueCagr` — base growth is the reported single-period growth clamped to
  the sector cap; bull/bear are derived around it. A cap is always reported as
  a model warning.
- `targetFcfMargin` — the current FCF margin is normalized to a sector cap
  (so a memory-cycle peak is not capitalized forever), then each scenario
  adjusts it. The margin path ramps from the current/normalized margin to the
  target over three years.
- `discountRate` — company WACC derived from beta, risk-free rate, equity risk
  premium, size premium, and tax-adjusted debt; scenario deltas around it.
- `exitFcfMultiple` — explicit exit-multiple lens, cross-checked against the
  Gordon terminal multiple `1 / (r - g)`. Divergence beyond 50% marks the
  terminal check inconsistent.
- `shareCagr` — dilution/SBC scenario. Per-share cash flows grow the share
  count year by year instead of using a static share count.

Growth follows a two-stage path: constant for years 1–5, then linear fade to
the 4% mature growth rate by year 10. `value` is the 5-year lens, `value10`
the 10-year lens.

## Fallback methods

- `dcf-scenarios` — positive FCF DCF with the scenario engine.
- `revenue-convergence` — non-positive FCF: margin converges from zero to the
  scenario target, so pre-profit names still get a value instead of being
  dropped.
- `analyst-fallback` / `revenue-multiple-fallback` — no usable financials:
  analyst target range, or a sector-implied price-to-sales lens.

## Output fields

Each valuation row keeps backward-compatible fields (`ev5`, `ev10`, `impl`,
`base_g`, `med`, `verdict`) and adds:

- `scenarios` — bear/base/bull `{ value, value10, revenueCagr, targetFcfMargin,
  discountRate, exitFcfMultiple, shareCagr, gordonMultiple }`.
- `valueRange` / `valueRange10` — scenario value map.
- `terminalCheck` — Gordon vs explicit exit multiple and consistency flag.
- `sensitivity` — 5-point grids for discount rate, revenue growth, and FCF
  margin deltas.
- `method`, `model_status`, `model_warnings`, `reported_g`, `implBound`.

The dashboard mapper (`_valuation_rows`) and the research workbench render the
new fields while keeping the old EV5/EV10 API fields intact.

## Tuning

Sector defaults live in `_sector_profile` in
`backend/src/trading_max/research/fundamentals.py`. Manual overrides belong in
`research/valuation_assumptions.json` under the ticker's `scenarios` block;
they take precedence over sector templates and are labelled
`assumptionSource: legacy-manual`.

Since v3's versioned store, assumptions are no longer read-only:

- The bundled catalog `valuation_assumptions_seed.json` seeds every watchlist
  ticker (legacy manual names plus explicit sector-derived entries).
- Settings → 估值场景假设 lets you edit bull/base/bear inputs per ticker and
  save them through `PUT /v1/valuation/assumptions/{ticker}`.
- Every save records a history entry (`GET /v1/valuation/assumptions/history`)
  with the revision, timestamp and the exact changed fields; the settings page
  shows the latest edits. No-op saves do not bump the revision.
- Every research run snapshots the current catalog as
  `research/valuation_assumptions.json`, so past valuations stay reproducible
  even after assumptions change.

## Scenario alerts

Research alerts include two scenario-band checks:

- `{ticker}:valuation:below-bear` — spot is below the bear-case value.
- `{ticker}:valuation:above-bull` — spot is above the bull-case value.

These complement the existing EV10 upside/downside alerts and are re-evaluated
on every research snapshot.

## Limitations

- Reported `revenueGrowth` is a single-period yfinance figure, not a structural
  forecast; the sector cap and warnings exist because of this.
- Terminal growth is a flat 4% for every name.
- Sector templates are deliberately conservative; a `very-expensive` verdict
  is a model statement, not a trading signal.
