# Intrinsic valuation findings (2026-08-22)

## Source basis

The primary reference used here is Aswath Damodaran's NYU Stern valuation curriculum and papers, supplemented by Ohlson's original residual-income paper. URLs are included so model behavior can be traced to an authoritative definition.

## 1. FCFF discounted cash flow (firm value)

**Definition.** Forecast free cash flow to the firm (after operating expenses and taxes, before interest/principal payments) and discount it at WACC. Enterprise/firm value is the present value of forecast FCFF plus terminal value; equity value then adjusts for debt, cash and other non-operating claims. Cash flows and discount rates must be matched (FCFF/WACC, not FCFF/cost of equity or FCFE/WACC).

**Applicability gate.** Prefer FCFF when leverage is high or expected to change, when debt data are incomplete, or when the product being valued is the whole business rather than just common equity. A stable-growth FCFF model requires a believable operating forecast, an estimable WACC, and a transition to a sustainable operating state. Keep the method unavailable (or return `indeterminate`) when operating cash flows, reinvestment, or WACC inputs cannot be estimated without invented values; use an explicitly probabilistic/scenario model for a young firm instead of hiding this uncertainty in WACC.

**Implementation implications.** Store FCFF and WACC as a typed pair; reject mismatched discount-rate/cash-flow types. Make non-operating cash, cross-holdings and debt adjustments explicit. Keep terminal-year FCFF consistent with the terminal reinvestment and ROIC assumptions (see Section 5).

Sources: [NYU DCF lecture](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/val.html), [Choosing the right DCF model](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/basics.html).

## 2. FCFE and dividend discount (equity value)

**FCFE.** FCFE is cash left after net income, net capital expenditure and working-capital investment, with the debt-financing share of reinvestment removed; discount at the cost of equity. Use FCFE when leverage is expected to be stable but dividends are materially different from FCFE or dividends are unavailable (for example, a private company/IPO). If leverage will change materially, FCFF avoids embedding changing debt flows in both cash flow and discount rate.

**Dividend discount (DDM).** Dividends are a specialized equity cash flow. Use DDM when dividends (including buybacks) are close to FCFE over an extended period or FCFE is unusually difficult to estimate (Damodaran cites financial-service firms). Do not use DDM as the primary intrinsic method for a non-dividend payer, a high-growth firm retaining cash, or a company whose payout is not a good proxy for distributable FCFE; it will generally be conservative when the firm can pay more than it distributes.

**Implementation implications.** Add gates for `leverage_stable`, `dividends_available`, and a payout-vs-FCFE comparison (document the chosen tolerance). Never discount FCFE/dividends at WACC. For a constant-growth terminal equity model require steady state, stable leverage and capex roughly in parity with depreciation; otherwise terminal FCFE is internally inconsistent.

Sources: [NYU model-selection notes](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/basics.html), [FCFE model](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/fcfe.html), [DDM notes](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/articles/ddm.htm).

## 3. Residual income / excess-return model

**Definition.** Equity value can be written as current book equity plus the present value of future residual income: `V0 = B0 + PV[NI_t - ke * B_(t-1)]`. Ohlson's formulation relies on the clean-surplus relation (dividends reduce book value and do not bypass earnings). Damodaran's equivalent excess-return framing is invested capital plus PV of future economic profits (`ROIC - WACC` times invested capital).

**Applicability gate.** This is useful when accounting book value and earnings are more forecastable than free cash flow (e.g., financial firms or businesses with difficult cash-flow definitions). Require a reconciled clean-surplus roll-forward, a meaningful starting book value, forecast earnings and equity, and a defensible cost of equity. Mark unavailable when book values are dominated by unrecognized intangibles or accounting adjustments that cannot be normalized, when dirty-surplus items/options are not reconciled, or when earnings/book forecasts are not more reliable than cash-flow forecasts. Residual income is not a way to avoid forecasting: terminal residual income must fade toward zero (or another explicitly sustainable excess-return state).

**Implementation implications.** Keep book-equity roll-forward and payout as separate typed inputs; expose `clean_surplus_ok` and `book_value_quality` gates. Report the implied excess-return fade and terminal ROE/ke assumptions; do not silently substitute FCFF inputs.

Sources: [Ohlson (1995), original clean-surplus model](https://onlinelibrary.wiley.com/doi/pdf/10.1111/j.1911-3846.1995.tb00461.x), [Damodaran residual/excess-return survey](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/valuesurvey.pdf), [NYU excess-return overview](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/background/valintro.htm).

## 4. Probability-adjusted scenarios for pre-revenue/high-growth firms

Young firms commonly have little/no revenue, operating losses, short histories and a material chance of failure, so a single point DCF and a punitive discount rate can be misleading. Damodaran recommends explicit scenario ranges/simulations for revenue, margins and costs and an explicit survival/distress adjustment. For truncation risk, value a going-concern DCF, estimate failure probability and distress-sale value, then compute `E[V] = P(going concern)*V_DCF + P(distress)*V_distress` (or a mutually exclusive bull/base/bear tree with probabilities that sum to one).

**Applicability gate.** Enable scenario mode for pre-revenue, negative-earnings, or high-growth companies when point forecasts are not credible. Require documented scenario definitions, probabilities (or calibrated distributions), timing, financing/cash runway and a terminal/liquidation payoff. Keep intrinsic value unavailable/indeterminate if neither market/operating evidence nor a defensible probability model exists; do not fabricate probabilities or bury survival risk in WACC. Return an expected value plus scenario range and key probability sensitivities.

Sources: [Damodaran, *Valuing Young and Growth Companies*](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/younggrowth09.pdf), [NYU probabilistic approaches and scenario analysis](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/DSV2ed.htm), [NYU distress-probability treatment](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/valquestions/a21.htm).

## 5. Terminal value, reinvestment and dilution constraints

* **Terminal growth.** Perpetual growth must be sustainable: Damodaran advises `g_terminal` no greater than the economy's nominal growth (and as a rule of thumb no greater than the risk-free rate), with discount rate strictly above `g`. A multiple-based terminal value inside a DCF introduces a relative-valuation assumption; prefer an explicit liquidation value or perpetual-growth value and label the choice.
* **Reinvestment.** Stable growth is earned, not free: `g = reinvestment_rate * ROIC` for FCFF (`g = equity_reinvestment_rate * ROE` for FCFE), hence `stable_reinvestment_rate = g / ROIC` (or `g / ROE`). Increasing terminal growth must increase reinvestment; otherwise the model double-counts growth. For a stable FCFE firm, capex should be roughly in parity with depreciation. Reject a terminal state with impossible reinvestment, `WACC <= g`, or an ROIC/ROE assumption that cannot be sustained.
* **High-growth fade.** High growth that creates value implies returns on new investment above the relevant cost of capital. Forecasts should fade growth, margins, leverage and excess returns toward stable-state values; do not permit indefinite high growth or indefinite excess returns by default.
* **Dilution.** Options, warrants and convertibles are claims on equity. Value them as options (or use a documented treasury-stock/fully diluted convention), subtract option value from equity value and divide by the correct share count. Expected future share issues should be reflected in forecast financing/cash flows and share count; simply dividing by today's basic shares understates dilution.

Sources: [NYU terminal-value approaches](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/valquestions/termvalapproaches.htm), [NYU terminal value and excess returns](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/valquestions/termvalueexreturns.htm), [NYU options/dilution guidance](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/valquestions/a25.htm), [Damodaran option/dilution paper](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/realopt.pdf).

## Suggested engine-level method status

Expose `available | unavailable | indeterminate` rather than forcing a number. Minimum hard stops are: cash flow/discount-rate mismatch; missing or non-defensible WACC/ke; terminal `discount_rate <= g`; missing sustainable reinvestment/return assumptions; missing clean-surplus/book-quality inputs for residual income; missing payout/leverage gates for DDM/FCFE; and missing scenario probabilities/payoffs for pre-revenue firms. When a hard stop is hit, return the failed gate and the missing inputs so a caller can select another method or provide evidence.
