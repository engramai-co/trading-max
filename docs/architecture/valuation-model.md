# Company valuation

The Research Desk and the batch publication use the same statement-based
forecast. Values are indicative equity values in major quote-currency units
per listed share. Each model has bear, base and bull scenarios, five- and
ten-year horizons, a base sensitivity matrix and a reverse reading. Broker
marks apply only to the same listing and currency in the desk. The batch
uses its own published technical price. Analyst targets remain market references.

## Eligibility and input identity

Funds and indices have no company valuation. A missing revenue observation
and reported zero revenue have different meanings. Only a reported zero
can support the reverse-only model below.

For each family, try the most recent complete four-quarter window, then earlier
complete windows, then the most recent fiscal year. The four quarters must be
consecutive. Revenue and cash flow (or earnings) must belong to the same
period. Balances use the closing observation for that period. The desk names
the chosen period and its end date. Unknown inputs stay missing.

Quote prices use major currency units, including GBP for a London pence quote.
Apply the stored reporting-to-quote FX rate once to statement amounts. If the
currencies differ, a missing rate blocks valuation. Use quoted shares
outstanding or, if absent, the published market capitalisation divided by the
batch price. A recognised depositary receipt requires a reviewed ratio.
Divide statement ordinary shares outstanding by ordinary shares per receipt
to obtain the equivalent listed count. A quoted count can also be used for a
verified one-to-one line. The current reviewed US listings are
[TSMC, five ordinary shares per ADS](https://investor.tsmc.com/sites/ir/sec-filings/2025_20F%20Report.pdf),
[Arm, one per ADS](https://investors.arm.com/node/8281/html) and
[Nokia, one per ADS](https://www.nokia.com/system/files/2026-03/nokia-form-20-f-2025.pdf).
Unknown receipt ratios block a per-share result.

## Selecting a family

The stored security master's GICS sub-industry selects the method. Banks
(401010) and insurance underwriters (403010 except insurance brokers
40301010) use residual income. Investment Banking & Brokerage (40203020)
uses net income. Payments, exchanges, asset managers, insurance brokers and
other operating companies use cash flow. Without a sub-industry, deposit or
insurance-contract balances indicate a bank or underwriter. Customer brokerage
payables and securities loaned indicate a broker. Other statements use cash flow.

Four reviewed US listings take precedence over broad provider classifications.
SoFi operates a deposit-taking bank. Robinhood and Coinbase run trading platforms
with customer funds. IREN operates computing infrastructure. The chosen family
is switchable at the desk, subject to the selected family's input requirements.
The evidence evaluator binds the automatic family before accepting proposals.
[SoFi filings](https://investors.sofi.com/financials/sec-filings/default.aspx),
[Robinhood filings](https://investors.robinhood.com/financials/sec-filings),
[Coinbase filings](https://investor.coinbase.com/financials/sec-filings/default.aspx),
[IREN annual filing](https://www.sec.gov/Archives/edgar/data/1878848/000187884826000052/iren-20260630.htm).

## Cash flow and earnings

The annual flow is revenue times projected margin. Cash-flow companies start
from operating cash flow less absolute capital expenditure. Trading platforms
use common earnings, or reported net income when a separate common earnings
line is absent. The earnings model assumes those earnings are available to
shareholders. It excludes client deposits and does not model regulatory
capital requirements.

1. Revenue compounds at the initial growth assumption through year five.
   For a ten-year forecast growth fades linearly to 3% in year ten.
2. Margin moves linearly from the actual starting margin to the target over
   the selected number of years. A thin margin is below 3%. The default ramp
   for thin or negative margins is five years for semiconductor, hardware and
   power-industrial profiles and four years otherwise. Other starting margins
   reach the target in three years.
3. Apply annual share-count change. Cash-flow losses draw down period-end cash
   and short-term investments. Once exhausted, issue shares at the frozen spot
   for the uncovered deficit. Distribute positive flows in the years earned.
   The annual net flow to equity includes the issue proceeds so that a funded
   deficit affects holders once through dilution. Missing opening cash blocks
   a scenario which needs funding. For trading platforms an earnings loss is
   retained as a loss. Customer cash does not fund that loss in this model.
4. Discount each annual net flow per projected share at cost of equity. Add
   the discounted final positive flow per share times the exit multiple. Apply
   a zero equity floor to the sum. No enterprise-to-equity debt bridge applies.
   The batch also reports a Gordon cross-check when cost of equity exceeds 3%.

Template targets and rates are assumptions. Historical revenue CAGR, available
from two or more annual statements, is capped by the sector growth template.
The desk retains the historical rate and the scenario adjustment separately.
In the absence of comparable annual statements, the labelled sector template
supplies the assumed growth. Configured cash-flow scenarios override template
inputs, including for issuers with negative starting flow.

## Residual income

Start with positive common equity per quoted share, using common earnings from
the same statement period. Default year-one ROE uses annualised common earnings
divided by closing common equity, shifted by five percentage points for bear
and bull. Payout defaults to 30%. Bear/base/bull terminal P/B defaults to
0.75/1/1.25. The desk exposes ROE, payout, cost of equity and terminal P/B.

For each year, fade ROE linearly from the year-one assumption to cost of
equity in the final forecast year. With opening book per share B, earnings
are ROE × B and residual income is earnings less cost of equity × B. Closing
book is B plus earnings less payout × positive earnings. This assumes
clean surplus and no further share issues. Losses reduce book in full.
Value is opening book plus discounted residual income plus the discounted
terminal premium (terminal P/B − 1) × ending book. A terminal P/B of one
therefore adds no premium. [CFA Institute, residual income valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/residual-income-valuation).

## Reverse readings and saved baselines

The base sensitivity grid varies cost of equity against initial growth or
year-one ROE. The reverse reading holds all other base inputs fixed and
solves for growth (−30% to 80%), target margin for loss-making flows
(−100% to 100%), or year-one ROE (−80% to 200%). A spot outside the search
interval returns a bound. A flat projection or an unavailable input withholds
the point estimate.

Reported zero revenue yields only the year-five revenue implied by spot.
Assume zero interim distributions. Required year-five revenue equals current
spot × year-five shares × (1 + cost of equity)⁵ divided by target margin ×
exit multiple. Both denominator inputs must be positive. The result is in
major quote-currency units and represents an operating requirement.

An explicitly saved model freezes the basis, assumptions, family, formula
version and worksheet. Earlier saved cash-flow versions retain their original
three-year ramp and share formula. Marking one version as the security's
baseline replaces the overview's model upside with its frozen five-year base
value divided by the current batch spot less one. A currency mismatch withholds
the reading. Clearing the designation restores the automatic batch result.
Editing or saving alone does not designate a baseline.

Valuation alerts remain disabled for indicative models pending back-testing
and calibration.
