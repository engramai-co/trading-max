# Relative valuation and market-reference findings

Research date: 2026-08-22. Sources are NYU Stern (Aswath Damodaran), CFA Institute, and CFA-published research/practice guidance. These are used as implementation guidance rather than as investment advice.

## Evidence-backed principles

### 1. Define peers by economics, not only by industry label

Damodaran’s “Anatomy of a Multiple” says the comparable should be similar in fundamentals (growth, risk, and cash-flow characteristics), even if it is not in the same industry. The workflow is: identify comparable assets, standardize values into multiples, then control for fundamental differences before judging relative cheapness/expensiveness. Direct one/two-company comparisons, peer-group medians/averages, and fundamental-adjusted comparisons are distinct methods; the latter can use a regression when the sample is broad enough.

Source: [NYU Stern, The Anatomy of a Multiple](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/multintr.htm); [NYU Stern, An Introduction to Valuation](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/background/valintro.htm).

**Implementation implication:** Build a reproducible peer eligibility/scoring layer (business/industry, geography, size, growth, profitability, leverage, and risk/volatility), retain the selected peer IDs and as-of date, and expose why each peer was included. Permit cross-industry peers only when their fundamental profile is demonstrably similar. Avoid an analyst-editable peer set with no audit trail.

### 2. Match numerator and denominator to the same claimholders

Damodaran’s consistency rule is that equity value must be divided by an equity claim (earnings or book value), while firm value must be divided by a firm-level claim. CFA Institute defines enterprise value as market value of debt, common equity and preferred equity less cash/investments. EV/EBITDA is preferred to P/EBITDA because EBITDA is pre-interest and therefore a flow to all capital providers; EV/EBITDA also helps compare different leverage and is common for capital-intensive businesses. EV/Sales is conceptually preferable to P/S when capital structures differ.

Sources: [NYU Stern, The Anatomy of a Multiple](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/multintr.htm); [CFA Institute, Market-Based Valuation: Price and Enterprise Value Multiples](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples); [NYU Stern, The Educated Investor (EV/EBITDA)](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/articles/diffmultiples.htm).

**Implementation implication:** Make the claimholder type explicit in every multiple definition. For EV multiples, calculate `implied_EV = peer_multiple × target_firm_metric`, then `implied_equity = implied_EV − debt − preferred + cash_and_investments`; for equity multiples, calculate implied equity directly and divide by diluted shares. Reject mixed pairs (for example, EV/FCFE or equity value/EBITDA) rather than silently producing a number.

### 3. Normalize periods and accounting definitions before comparing

Both sources stress uniform estimation across peers and consistent accounting rules. CFA guidance distinguishes trailing and forward P/E, warns that trailing multiples need a lag to avoid look-ahead bias, and recommends normalized EPS for cyclicality: historical average EPS over a full cycle or average ROE multiplied by current book value per share. Sales are generally more stable and less distorted than EPS/book value, but P/S can ignore cost-structure differences and revenue-recognition manipulation. CFA’s equity-research practice guidance says cyclical companies should be tested on normalized earnings/cash flows rather than a peak/trough snapshot.

Sources: [NYU Stern, The Anatomy of a Multiple](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/multintr.htm); [CFA Institute, Market-Based Valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples); [CFA Institute, Best Practices for Equity Research Analysts (PDF)](https://www.cfainstitute.org/-/media/documents/support/research-challenge/challenge/best-practices-equity-sample.pdf).

**Implementation implication:** Store metric period/type (`TTM`, `NTM`, fiscal year), fiscal-period end, currency/FX basis, share-count basis, and accounting adjustments. Align peers to the same observation date and denominator definition. Offer a “normalized” series with a documented full-cycle window or ROE method; never mix reported and adjusted figures without labeling. Prevent look-ahead by lagging trailing data to the information-available date.

### 4. Route loss-making and high-growth companies to metrics that remain defined

CFA notes that EPS is volatile and can be negative; P/E is not meaningful at zero/negative EPS, while earnings yield (E/P) remains rankable. P/S is attractive because sales are never negative and generally less distorted, but it does not capture margin/cost structure and may fail for loss-making firms unless margins are considered. EV/EBITDA is useful where EBITDA is positive and capital intensity/leverage make a firm-level metric appropriate; a negative EBITDA still makes that multiple unusable. CFA identifies growth, profitability/margins, and required return/WACC as the fundamental drivers of P/S and EV/EBITDA, and PEG incorporates growth through the P/E-to-consensus-growth ratio.

Source: [CFA Institute, Market-Based Valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples).

**Implementation implication:** Treat undefined/negative denominators as a first-class state, not zero or infinity. For pre-profit/high-growth names, prefer EV/Sales or P/S with explicit gross/EBITDA/operating-margin and growth controls; use EV/EBITDA only when positive and economically comparable. If using PEG or forward metrics, show the growth source and confidence/staleness flags. If no economically meaningful denominator exists, return “not covered by relative model” and fall back to an intrinsic/asset/option lens rather than forcing a multiple.

### 5. Use robust aggregation and make outlier policy visible

Damodaran reports that multiple distributions are non-normal and asymmetric; the median is often more representative than the arithmetic mean. He cautions that simply deleting large positive outliers can bias the estimate when outliers are one-sided, and that data services differ because they trim or cap outliers differently. CFA lists arithmetic mean, harmonic mean, weighted harmonic mean, and median as distinct central-tendency choices; the choice should be tied to the use case and documented.

Sources: [NYU Stern, The Anatomy of a Multiple](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/multintr.htm); [NYU Stern, iValuebook (outliers and averages)](https://pages.stern.nyu.edu/~adamodar/pdfiles/uValue/uValuebook.pdf); [CFA Institute, Market-Based Valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples).

**Implementation implication:** Default to median with P25/P75 (or a median-based range), sample count, and a peer-level table. Apply deterministic validity screens (missing/negative denominator, stale observation, non-positive EV where inappropriate) before aggregation. If winsorization/capping or a weighted/harmonic mean is used, record the rule and publish both raw and transformed counts; do not silently drop one-sided outliers. Require a minimum effective peer count and widen the range when the sample is small or dispersed.

### 6. Treat consensus estimates and reference prices as noisy context

CFA-published research comparing 66,100 Wall Street consensus estimates with reported earnings found significant forecast errors, with only a minority inside a range many professionals would consider acceptable; the authors question finely calibrated forecasts embedded in valuation models. CFA equity-research guidance warns that a stock apparently cheap on a forward-consensus multiple may merely have a stale consensus estimate that the market has already discounted. A CFA practitioner article also notes that static price targets are highly sensitive to human-selected inputs and may be arbitrary; they should be a rough reference, not the final trigger.

Sources: [Dreman & Berry, Analyst Forecasting Errors and Their Implications for Security Analysis (CFA Institute / Financial Analysts Journal)](https://rpc.cfainstitute.org/research/financial-analysts-journal/1995/analyst-forecasting-errors-and-their-implications-for-security-analysis); [CFA Institute, Best Practices for Equity Research Analysts (PDF)](https://www.cfainstitute.org/-/media/documents/support/research-challenge/challenge/best-practices-equity-sample.pdf); [CFA Institute, Equity Investing: When is it Time to Sell?](https://blogs.cfainstitute.org/insideinvesting/2013/04/24/equity-investing-when-is-it-time-to-sell/).

**Implementation implication:** Ingest consensus/reference-price data only as a separately labeled market-reference lens. Persist provider, timestamp, horizon, estimate count, dispersion, revision age, and methodology; show a staleness warning and avoid using a stale or single-estimate target as a peer multiple. Never let consensus silently overwrite the intrinsic forecast. Require a materiality buffer before calling misvaluation and show sensitivity to consensus changes.

### 7. Relative valuation complements, but cannot replace, intrinsic valuation

Damodaran states that relative valuation gives up estimating intrinsic value and trusts the market to be right on average; it can identify a stock that is cheap/expensive only relative to the chosen group and can embed sector-wide overvaluation/undervaluation. CFA describes absolute (intrinsic) and relative models as complementary and notes that analysts often use more than one model because model applicability and input changes create estimate variability. Relative multiples can also be used as a terminal-value cross-check in a multistage DCF, but the benchmark must be justified by comparable fundamentals.

Sources: [NYU Stern, An Introduction to Valuation](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/background/valintro.htm); [CFA Institute, Equity Valuation: Concepts and Basic Tools](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/equity-valuation-concepts-basic-tools); [CFA Institute, Market-Based Valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples).

**Implementation implication:** Keep intrinsic and relative outputs independent, then present a reconciliation: intrinsic value/range, relative implied value/range, market-reference range, peer count/dispersion, and the spread between methods. Use relative valuation as a market-calibration and reasonableness check (or DCF terminal-value cross-check), not as an automatic override. Flag “relative cheap but intrinsically expensive” and the converse as different diagnoses rather than collapsing them into one score.

## Suggested V1 output contract

For each covered instrument, return:

1. `relative_status`: `covered`, `insufficient_peers`, or `no_valid_denominator`.
2. Peer set with IDs, selection features, observation date, and exclusion reasons.
3. Multiple definitions with claimholder type, period (`TTM`/`NTM`/normalized), numerator/denominator fields, and validity flags.
4. Median, P25/P75, sample/effective sample count, dispersion, and explicit outlier transformation metadata.
5. Implied EV/equity bridge and per-share range, with FX and diluted-share assumptions.
6. Consensus/reference fields (provider, timestamp, estimate count, dispersion, staleness) kept separate from model output.
7. A reconciliation against intrinsic valuation and a plain-language warning whenever the two lenses disagree materially.
