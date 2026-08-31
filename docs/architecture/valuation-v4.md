# Valuation engine v4

## Decision

`research.valuation` publishes **indicative valuation ranges**, not factual
target prices. It refuses unsupported methods and keeps analyst consensus as a
separate market reference.

The evidence and design rationale are recorded under
`docs/research/valuation-engine-2026-08-22/`.

## Automatic lens

The current provider exposes a `freeCashflow` measure but not the complete
operating reinvestment bridge required for verified FCFF. V4 therefore treats
that field as a levered free-cash-flow proxy and pairs it with cost of equity.
It does not subtract net debt from the resulting equity value.

For eligible names, each bear/base/bull scenario specifies:

- revenue growth with a fade toward 3% mature growth;
- an explicit FCF-margin path;
- cost of equity;
- share dilution;
- an exit FCF multiple.

The declared exit multiple is actually used in the calculation. A Gordon
growth result is calculated independently as a terminal-method cross-check.
Material disagreement is retained as a model warning and the UI presents the
result as a range.

## Applicability gates

- Positive levered FCF proxy plus usable revenue, shares, price, and currency:
  `indicative`.
- Non-positive FCF: unavailable unless all three versioned scenarios explicitly
  supply growth, margin, discount, dilution, and terminal-multiple assumptions.
- Financial companies: unavailable until a residual-income or dividend/FCFE
  implementation has verified book-value, clean-surplus, leverage, and payout
  inputs.
- Missing FX or required operating inputs: unavailable.
- Analyst targets never populate the intrinsic scenario values.

## Output semantics

- `ev5` / `ev10`: base scenario values using five- and ten-year explicit
  forecast horizons; retained for API compatibility.
- `valueRange` / `valueRange10`: bear/base/bull scenario ranges.
- `verdict`: `below-model-range`, `within-model-range`,
  `above-model-range`, or `not-covered`. These describe position relative to
  the selected model range; they are not objective cheap/expensive claims.
- `model_status`: `indicative` until horizon-matched back-testing and interval
  calibration have passed.
- `valuationPolicy`: cash-flow type, discount-rate type, terminal method,
  selected horizon, consensus treatment, and validation status.

Valuation alerts are disabled for `indicative` and `unavailable` models. They
may resume only when a later model earns `ready` through documented validation.

## Future independent lenses

- FCFF/WACC when EBIT, taxes, working capital, capex, depreciation, and
  reinvestment are available;
- residual income for financial firms;
- probability-adjusted scenario valuation for young/pre-revenue firms;
- peer-relative valuation after reproducible peer selection and metric
  normalisation exist.

