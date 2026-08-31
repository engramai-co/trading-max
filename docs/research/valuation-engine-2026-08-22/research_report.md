# Valuation engine v4 research synthesis

## Why v3 is not trustworthy

The current implementation has several model-risk defects, not merely tuning problems:

1. It exposes an exit FCF multiple in every scenario but never passes that multiple into the valuation function. The displayed assumption and calculated value therefore disagree.
2. Yahoo Finance `freeCashflow` is a levered cash-flow proxy, yet v3 discounts it at WACC and then subtracts net debt. That mismatches cash flow and discount rate and can double-count financing claims.
3. The five-year shortcut drives the expensive/cheap verdict even for companies whose growth is explicitly expected to fade over ten years.
4. A warning-level or terminal-inconsistent model still emits definitive labels such as `very-expensive` and valuation alerts.
5. Analyst targets and sector P/S shortcuts can silently become a valuation fallback even though they are market-reference lenses, not intrinsic value.
6. Negative-FCF firms receive an automatic convergence story without an explicit probability of survival, financing requirement, or user-supplied scenario evidence.

## v4 policy

### Automatic cash-flow lens

- Treat provider `freeCashflow` as a **levered FCF proxy** and pair it with cost of equity, not WACC.
- Do not subtract net debt from that equity cash-flow result.
- Use explicit bear/base/bull forecasts, dilution, and a ten-year fade for high-growth companies.
- Honour a declared exit FCF multiple as a labelled market-calibrated terminal method; calculate a Gordon value separately as the intrinsic cross-check.
- Reduce perpetual growth to 3% and require the discount rate to remain above terminal growth.

### Applicability and status

- Positive levered FCF plus complete revenue/share inputs: `indicative` scenario lens.
- Non-positive FCF: only run an explicit scenario lens when a versioned scenario set supplies growth, margin, discount rate, dilution, and terminal multiple. Otherwise return unavailable rather than inventing convergence.
- Financial companies remain outside this automatic cash-flow method until a residual-income or dividend/FCFE implementation has the necessary book-value and payout data.
- Analyst targets remain a separate market reference and never populate intrinsic `ev5`/`ev10`.

### Conclusions

- Until the engine has horizon-matched back-testing and interval calibration, conclusions describe **price position versus model range**, not objective under/overvaluation.
- Models with capped inputs, inconsistent terminal methods, or missing evidence cannot emit strong valuation alerts.
- The selected horizon is ten years for high-growth companies and five years for mature companies; this choice is recorded in the artifact.

## Follow-on methods

The evidence supports adding, as independent lenses rather than silent fallbacks:

- FCFF/WACC once EBIT, taxes, reinvestment, and working-capital inputs are available;
- residual income for financial firms when clean-surplus and book-value quality can be verified;
- probability-adjusted scenarios for pre-revenue firms with explicit survival/distress inputs;
- peer-relative valuation only after a reproducible peer-selection and denominator-normalisation stage exists.

The detailed source notes are in `findings_intrinsic.md`, `findings_relative.md`, and `findings_guardrails.md`.
