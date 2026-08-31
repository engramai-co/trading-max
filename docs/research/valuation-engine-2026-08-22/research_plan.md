# Trading Max valuation-engine research plan

## Main question

How should Trading Max replace its current one-size-fits-all valuation logic with an evidence-based valuation engine that produces defensible ranges, refuses unsupported precision, and handles profitable, high-growth, loss-making, financial, and pre-revenue companies with appropriate methods?

## Subtopics

1. **Intrinsic valuation methods and applicability gates**
   - Establish when FCFF DCF, FCFE/dividend models, residual-income models, or probability-adjusted scenario valuation are appropriate.
   - Identify terminal-value, reinvestment, dilution, and convergence constraints from primary academic or practitioner sources.

2. **Relative valuation and market-reference methods**
   - Determine defensible peer-selection, metric-normalisation, loss-making-company, and analyst-consensus rules.
   - Define how market references should complement rather than override intrinsic valuation.

3. **Uncertainty, data quality, and product guardrails**
   - Specify scenario/range construction, sensitivity design, provenance, stale-data handling, and conditions that must make a valuation partial or unavailable.
   - Identify validation and back-testing expectations suitable for a decision-support product.

## Synthesis

The findings will become a typed valuation policy: company classification first, method selection second, explicit assumptions and quality gates third, and a range-based result with traceable components. The existing UI will remain largely intact, but it must display the selected method, evidence quality, range, and unavailable reasons rather than a misleading universal point estimate.
