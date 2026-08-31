# Valuation-engine guardrails (2026-08-22)

Scope: practical controls for a retail portfolio valuation engine that combines broker positions, market prices, corporate actions, and research/model estimates. The sources below are regulator, standard-setter, or national-metrology guidance; implications are engineering recommendations derived from those sources.

## Findings and implementation implications

### 1. Treat a valuation as an estimate with explicit uncertainty, not a point fact

- IFRS 13 states that present-value fair values are made under uncertainty because cash-flow amounts and timing are estimates; a faithful measurement includes compensation for risk/uncertainty. It also requires disclosure of valuation techniques and significant unobservable inputs, including the effect of reasonably possible alternative inputs for Level 3 measurements. Source: [IFRS 13 standard (B15-B17; disclosure requirements)](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ifrs-13-fair-value-measurement.pdf?bypass=on); [IFRS 13 overview](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-13-fair-value-measurement/).
- IASB’s IFRS 13 disclosure work describes a useful range pattern: explain uncertainty caused by significant inputs and, where reasonably possible, show higher/lower fair values from alternative inputs. Source: [IASB Update, November 2019](https://www.ifrs.org/news-and-events/updates/iasb/2019/iasb-update-november-2019/).
- NIST guidance says a measurement result includes both the estimate and its associated uncertainty; uncertainty can be propagated to derived quantities. Source: [NIST SP 260-136, Evaluating, Expressing, and Propagating Measurement Uncertainty](https://www.nist.gov/publications/evaluating-expressing-and-propagating-measurement-uncertainty-nist-reference-materials).

Implementation:

1. Return `point_estimate`, `lower`, `upper`, confidence/coverage convention, and a machine-readable list of uncertainty drivers (price age, FX, corporate-action status, model inputs, liquidity).
2. Build ranges from explicit alternative-input scenarios (base/up/down or quantiles), preserving correlation where material; do not label a range as a statistical confidence interval unless its coverage method is documented.
3. Aggregate uncertainty conservatively: identify common drivers (e.g., market beta, FX) so portfolio ranges do not falsely assume every holding is independent.
4. Put scenario assumptions and their effective timestamp beside every displayed total; keep a reproducible scenario ID in the API response.

### 2. Make sensitivity useful and bounded

- IFRS 13 requires information that lets users understand sensitivity to reasonably possible changes in significant unobservable inputs, and the IASB discussion explicitly contemplates quantitative high/low ranges. Source: [IFRS 13 PDF](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ifrs-13-fair-value-measurement.pdf?bypass=on); [IASB Update](https://www.ifrs.org/news-and-events/updates/iasb/2019/iasb-update-november-2019/).
- Federal Reserve supervisory expectations recommend sensitivity analysis and benchmark/challenger models where back-testing stress models is difficult. Source: [FRB CCAR internal-controls guidance](https://www.federalreserve.gov/bankinforeg/stress-tests/ccar/August-2013-Internal-Controls.htm).

Implementation:

- Present one-at-a-time sensitivities for explainability and a small set of joint stress scenarios for portfolio risk; show the input shock and resulting portfolio delta.
- Cap or flag extrapolation outside the model’s validated input domain. A “stress” number must not silently become a forecast or target price.
- Rank sensitivities by contribution to valuation interval width, not by arbitrary decimal changes.

### 3. Detect stale, missing, and inconsistent market data before valuation

- The SEC explicitly advises monitoring “stale pricing” (prices that do not change), checking whether an override or input is wrong, comparing fair values with actual market sales, and investigating persistent bias. Source: [SEC speech, Valuation, Trading, and Disclosure](https://www.sec.gov/news/speech/spch499.htm).
- Interagency guidance says process verification should ensure internal and external inputs remain accurate, complete, and consistent with model purpose/design, with ongoing monitoring as products, data relevance, and market conditions change. Source: [Federal Reserve revised model-risk guidance (SR 26-2)](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm); [FRB interest-rate-risk FAQ](https://www.federalreserve.gov/frrs/guidance/interest-rate-risk-frequently-asked-questions-regarding-interagency-advisory.htm).

Implementation:

- Store `observed_at`, `as_of`, source, quote type (trade/mid/close), currency, and age for every price; calculate market-session-aware staleness rather than a fixed wall-clock threshold.
- Block or downgrade confidence when required prices, FX, splits/dividends, or positions are missing; never backfill silently. Return a structured `data_quality` state (`fresh`, `stale`, `missing`, `inconsistent`) and explain its valuation impact.
- Cross-check duplicate feeds and broker totals; compare model marks to subsequent executable prices/transactions and track signed bias and error by instrument/source.

### 4. Preserve provenance and traceability end-to-end

- NIST defines traceability as an unbroken, documented chain to a reference, with each link contributing to measurement uncertainty; it cautions that traceability alone does not establish fitness for purpose. Source: [NIST Metrological Traceability FAQ and Policy](https://www.nist.gov/metrology/metrological-traceability).
- ISO 8000-1 frames data quality as a managed lifecycle with explicit principles and a path to quality. Source: [ISO 8000-1:2022 overview](https://www.iso.org/standard/81745.html).

Implementation:

- Attach provenance to each valuation component: provider/feed, instrument identifier mapping, retrieval time, as-of time, raw-record hash or immutable reference, transformations, corporate-action version, FX source, model/version, and scenario ID.
- Keep an append-only valuation ledger so a displayed total can be replayed from the exact inputs and code/model versions; expose provenance links to users without exposing credentials.
- Version data-quality rules and mapping tables; record overrides with actor, reason, timestamp, and expiry.

### 5. Avoid unsupported precision and false certainty

- NIST states that an uncertainty statement is part of a measurement result and that traceability is not the same as fitness for purpose. Source: [NIST traceability policy](https://www.nist.gov/metrology/metrological-traceability); [NIST uncertainty propagation](https://www.nist.gov/publications/evaluating-expressing-and-propagating-measurement-uncertainty-nist-reference-materials).

Implementation:

- Round displayed prices/totals to a precision justified by quote precision, spread, FX precision, and the valuation interval; retain higher precision only internally for arithmetic.
- If interval width exceeds a materiality threshold, show an interval or qualitative band rather than a cents-level total; annotate “indicative” vs “executable/observed.”
- Do not infer confidence from extra decimal places. Every confidence/coverage label must name its method and assumptions.

### 6. Disclose model choice, assumptions, and limitations

- Federal Reserve SR 26-2 calls for documenting model design, key choices, assumptions, qualitative judgments, data selection, implementation, limitations, and appropriate use; validation should clarify when outputs are unreliable or require corrective action. Source: [SR 26-2 revised guidance](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm).
- IFRS 13 requires disclosure of valuation techniques and changes to technique, including the reasons for changes, and significant unobservable inputs/sensitivity. Source: [IFRS 13](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ifrs-13-fair-value-measurement.pdf?bypass=on).

Implementation:

- For each instrument/valuation lens, disclose method selected, why it is appropriate, key inputs, fallback hierarchy, excluded inputs, calibration date, and known failure modes.
- If multiple methods are plausible, retain a challenger estimate or benchmark and show method-selection status; do not silently switch models when data disappear.
- Surface model applicability (asset class, liquidity, horizon, currency, data coverage) and a “not suitable” state.

### 7. Validate before use, back-test out of sample, and monitor drift

- SR 26-2 describes validation as conceptual-soundness review, outcome analysis, and ongoing monitoring; rigor and frequency should be risk/materiality based. It recommends comparing outputs with real-world outcomes, investigating persistent deviations, and recalibrating/redeveloping when performance deteriorates. Source: [Federal Reserve SR 26-2](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm).
- The earlier SR 11-7 text gives concrete back-testing guardrails: use data not used in model development, match observation frequency to the forecast horizon, compare outcomes with expected ranges/confidence intervals, investigate material/frequent exceptions, and use parallel testing when changing models. Source: [SR 11-7 attachment](https://www.federalreserve.gov/boarddocs/srletters/2011/sr1107a1.pdf).

Implementation:

- Gate production use on documented conceptual review, unit/integration tests, holdout or walk-forward tests, and independent review proportionate to model materiality.
- Back-test each valuation lens against realized prices/transactions or later authoritative marks at the same horizon; report coverage, MAE/MAPE where meaningful, signed bias, exception rate, and interval calibration.
- Monitor by asset class, liquidity bucket, provider, and market regime; trigger review when drift, stale-input rate, interval under-coverage, or bias crosses a predefined threshold.
- When changing a model or provider, run old/new models in parallel on the same inputs and retain the comparison before cutover.

## Minimum product contract suggested by the evidence

Every valuation response should carry: `as_of`, `observed_at`, `point_estimate`, `range` plus coverage convention, scenario assumptions/ID, confidence/data-quality state, source and transformation provenance, model/version and method-selection disclosure, and validation status. Totals should be marked non-comparable when holdings mix materially different as-of times, currencies, or stale/missing inputs.

