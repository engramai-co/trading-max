# Company valuation

The Research Desk and the batch publication use the same statement-based
forecast. Values are indicative equity values in major quote-currency units
per listed share. Each model has bear, base and bull scenarios, five- and
ten-year horizons, a base sensitivity matrix and a reverse reading. Broker
marks apply only to the same listing and currency in the desk. The batch
uses its own published technical price. Analyst targets remain market references.

## Preview API

`GET` and `POST /v2/research/{ticker}/valuation-preview` expose the family-aware
contract. GET accepts an optional `family` query parameter. POST carries the
family and formula version in the request body. An operating model with reported zero revenue has
empty scenarios and sensitivity and a year-five revenue requirement. A
residual-income year exposes ROE, book and earnings, with nullable operating
fields. Its terminal present value is the discounted sale price, with the
premium in `terminalPremiumPresentValue`.

The v1 preview routes use the published cash-flow formula, its three-year
margin ramp and its five operating inputs. GET, POST and a legacy save
reproduce the same worksheet. A family or basis the published v1 client
cannot display returns HTTP 422. Family-aware saves specify their family or
formula version. Saved models record the version used to calculate them.

## Eligibility and input identity

Funds and indices have no company valuation. A missing revenue observation
and reported zero revenue have different meanings for cash flow and net income.
Only a reported zero can support their reverse-only model below.

For each family, try the most recent complete four-quarter window, then earlier
complete windows, then fiscal years from newest to oldest. A cash-burning
period needs its closing cash balance. Residual income needs matched common
earnings and positive common equity. Revenue can be missing, zero or negative.
The optional nonnegative revenue input can be empty on a residual-income
worksheet, and the financial statements retain any signed revenue observation.
The four quarters must be consecutive. Revenue and cash flow (or earnings) must belong to the same
period. Balances use the closing observation for that period. The desk names
the chosen period and its end date. Unknown inputs stay missing.

Quote prices use major currency units, including GBP for a London pence quote.
Apply the stored reporting-to-quote FX rate once to statement amounts. If the
currencies differ, a missing rate blocks valuation. An ordinary-share quote needs
an identified listing and a positive share-class identification. The existing SEC cover parser joins the trading
symbol, exchange and security title within one XBRL context. The latest
parsed filing or an explicit catalog type attached to the quoted symbol and
venue can establish an ordinary share. Venue matching uses the exchange MIC
and recognises provider aliases such as NYQ for NYSE. The catalog stores types
at issuer level, so a record covering several listings cannot by itself
establish which instrument has that type. A receipt flag takes precedence.
For a verified ordinary line, use period-end ordinary shares from the same
consolidated statement period as the forecast inputs. If the period omits the
count for a single-class company, use the quote's shares outstanding or the
published market capitalisation divided by the batch price. The batch records
the denominator in `sharesOutstanding` and the original quote count in
`quotedSharesOutstanding`. The evidence worksheet identifies the source of
the count.

**Multiple ordinary classes.** A listed B-class count covers only part of
the cash flows when the company also has A shares. For shares with verified
equal distributions per share, divide consolidated cash flows by the combined
period-end ordinary shares. If a period lacks this balance, try an earlier
complete period. Volvo's A and B shares pay the same dividend and carry
different voting rights. Novo Nordisk describes different priority rights
and equal dividends paid in practice. Its Copenhagen B forecast assumes that
equal distribution continues. Compare the resulting per-share value with the
price of the selected local class. The model withholds values for additional
ordinary classes identified on a filing cover or by an A/B ticker suffix until
their economic units are established.
[Volvo share terms](https://www.volvogroup.com/en/investors/the-volvo-share.html) ·
[Novo Nordisk share terms](https://annualreport.novonordisk.com/2025/strategic-aspirations/financial-performance.html)

**Receipts.** Divide period-end ordinary shares outstanding by the verified
ordinary shares per receipt on that venue. A one-to-one receipt may also use a
quoted count. The NYSE lines for TSM, Alibaba, Nokia and BP represent five,
eight, one and six ordinary shares respectively. Arm's Nasdaq ADS represents
one ordinary share. Shell’s NYSE ADS represents two ordinary shares. A US
time zone alone cannot identify a receipt venue.
BP's London line is an ordinary share quoted in pence. Its USD statements
use the stored USD-to-GBP rate once.
[TSMC](https://investor.tsmc.com/sites/ir/sec-filings/2025_20F%20Report.pdf) ·
[Alibaba](https://www.sec.gov/Archives/edgar/data/1577552/000119312526231755/baba-20260331.htm) ·
[Nokia](https://www.nokia.com/system/files/2026-03/nokia-form-20-f-2025.pdf) ·
[Arm](https://investors.arm.com/node/8281/html) ·
[BP listing and ADS terms](https://www.bp.com/investors/shareholder-and-dividend-information/share-listing-information) ·
[Shell shareholder FAQ](https://www.shell.com/investors/information-for-shareholders/shareholder-faqs.html)

**Retained snapshots.** Before the first new batch, the desk and evidence
reader can recover the unit from an exact filed designation, the security
master in that snapshot, or issuer-reviewed terms for the quoted listing.
FX is checked separately against the reporting currency, quote currency and
financial facts. A new batch records the venue used for the share-unit decision.
When a retained row lacks that venue or quotes a different venue, the readers
verify the unit again against the pinned sources and the reviewed listing terms.
A completed old worksheet and a matching currency provide
no share-class evidence. An unidentified unit withholds the per-share result.

## Selecting a family

The stored security master's GICS sub-industry selects the method. Banks
(401010) and insurance underwriters (403010 except insurance brokers
40301010) use residual income. Investment Banking & Brokerage (40203020)
uses net income. Payments, exchanges, asset managers, insurance brokers and
other operating companies use cash flow. Without a sub-industry, deposit or
insurance-contract balances indicate a bank or underwriter. The Yahoo bank
template used by JPMorgan Chase and Bank of America reports both
`Cash Cash Equivalents And Federal Funds Sold` and `Other Non Interest Expense`. Customer brokerage
payables and securities loaned indicate a broker. Other statements use cash flow.

Five reviewed US listings take precedence over broad provider classifications.
SoFi operates a deposit-taking bank. Robinhood and Coinbase run trading platforms
with customer funds. Interactive Brokers segregates customer funds under its
brokerage regulatory requirements. Restricted cash alone is inconclusive,
including for payment networks and exchanges. IREN operates computing infrastructure. The chosen family
is switchable at the desk, subject to the selected family's input requirements.
The evidence evaluator binds the automatic family before accepting proposals.
[SoFi filings](https://investors.sofi.com/financials/sec-filings/default.aspx),
[Robinhood filings](https://investors.robinhood.com/financials/sec-filings),
[Interactive Brokers annual filing](https://www.sec.gov/Archives/edgar/data/1381197/000138119726000062/ibkr-20251231.htm),
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
therefore adds no premium. Terminal dependence is the full discounted exit
price (terminal P/B × ending book discounted to today) divided by the equity
value. With zero payout, the exit supplies the entire value. [CFA Institute, residual income valuation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/residual-income-valuation).

## Reverse readings and saved baselines

The base sensitivity grid varies cost of equity against initial growth or
year-one ROE. The reverse reading holds all other base inputs fixed and
solves for growth (−30% to 80%), target margin for loss-making flows
(−100% to 100%), or year-one ROE (−80% to 200%). A spot outside the search
interval returns a bound. A flat projection or an unavailable input withholds
the point estimate. For a financed margin, split the search where annual flow
changes sign or cumulative burn exhausts cash. Within each regime the solver
bounds the price and its slope using the individual discounted per-share
flows. It reports a margin only when exactly one crossing can be established.

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

A saved version can be compared with the latest statements, price and
exchange rate and with the editor's current proposal. The comparison and
locked assumptions are described in the [valuation agent](valuation-agent.md#reviewing-new-evidence)
notes.

Valuation alerts on model value against price remain disabled for indicative
models pending back-testing and calibration. A saved version can instead say
that new evidence has arrived; see the
[notices of new evidence](valuation-agent.md#notices-of-new-evidence).
