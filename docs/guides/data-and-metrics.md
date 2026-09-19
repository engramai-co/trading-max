# Data and metric conventions

[Documentation](../README.md)

## Where the data comes from

Trading 212 supplies read-only account and transaction data. The research
adapter uses Yahoo Finance-compatible market data, public disclosure sources,
and supported issuer datasets. Provider coverage, timestamps, and permissions
vary. The app does not create market data to fill an unavailable dataset.

Development screenshots may use a dedicated broker-only preview with
hypothetical Trading 212 inputs. Its market prices, FX, research, and supported
ETF constituents still come from the real adapters. Test fixtures are synthetic
and separate from the running product.

See [provider notices](../../THIRD_PARTY_NOTICES.md) and
[privacy](../../PRIVACY.md) for requests and storage.

## Optional Alpaca reconstruction enhancement

Yahoo Finance remains the default. In **Settings → Accounts & data →
Reconstruction market data**, connect a free Alpaca Paper account using its
API Key ID and Secret. Test both historical feeds, then choose **Save and
Enable**. The next account refresh replays reconstruction; live broker
collection is unchanged. Turn the enhancement off to return to the YF-only
path, or remove the saved keys. Changes apply without a service restart.

The enabled path supplements US stock history with SIP five-minute bars and
BOATS one-minute overnight bars. Basic access is delayed by at least fifteen
minutes; the adapter requests data at least sixteen minutes old to allow for
clock drift. This is historical reconstruction, not a real-time quote service.
Only GET requests to the fixed Alpaca market-data host are used. No order or
account-trading endpoints are called.

UK instruments, FX and research continue using the existing providers. Valid
YF prices remain available when Alpaca fails. During the overnight session,
prices older than ten minutes are rejected even when YF has an older hourly
bar: a failed feed or a quiet security must not become a fabricated valuation.
Broker observations are retained exactly, including when reconstruction is
missing. Full replays publish per-symbol/feed coverage and failures under
`account/nav/market_data.json`; source bars live in a separate external cache.

Keys are stored on the server's OS credential manager and excluded from
backups. A restored server needs credentials re-entered. Other connection
metadata survives migration unchanged. When reverting to a version before
1.4.6, remove the Alpaca connection using the new Settings page first, or
restore the verified pre-upgrade backup; older versions cannot read the new
provider metadata. Data is subject to the user's Alpaca
permissions and [historical overnight access rules](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api).

## Units and periods

- Currency labels identify the displayed currency. A GBP portfolio value and
  a USD company quote are not directly interchangeable.
- `k`, `m`, and `bn` mean thousand, million, and billion. Exact detail tables
  retain precision. A 5% rate is displayed as 5%, not the internal ratio 0.05.
- Financial observations retain their reporting period and source. Annual,
  quarterly, TTM, forecasts, and current provider summaries are distinct.
- Weighted-average shares support per-share calculations. Period-end shares
  describe a point in time; their difference is not dilution.

## Account value is not investment return

Money P&L subtracts net external contributions from the change in value.
The percentage version divides by opening account value. Time-weighted return
instead compounds flow-adjusted period returns from reconciled daily history.
These measures can differ, especially when contributions are large.

Intraday account values combine broker observations with ledger-based
reconstruction. History is evaluated every ten minutes, but older market
inputs can be hourly and may carry forward the latest completed bar. This does
not recreate missing ten-minute trades. Observed broker values take precedence
and are not smoothed to fit the model.

Display buckets are 10 minutes (1D), 30 minutes (5D), one hour (1M), two hours
(3M), and four hours (6M). YTD follows its elapsed span and becomes daily beyond
six months; 1Y and All use daily values. Calculations use all stored observations
before display sampling. Earlier daily-only history stays daily. A dashed
connector indicates a display bucket with no usable observation, not invented
intermediate records. See the [range table](portfolio.md#read-money-and-pl).
Full overnight coverage is not guaranteed by pre/post-market bars.

Reconstruction selects the newest completed price across the available minute
and hourly feeds before checking its age. Active-session validity starts at the
actual open, including supported pre/post-market sessions. With hourly coverage,
the fallback allowance is two hours; minute-only coverage retains its two-bar
limit. A finer quote used under the hourly allowance is reported at the coarser
resolution. Weekend/holiday carry requires a quote near the latest session's
close and ends when the next covered trading session opens. A complete replay
removes estimates that no longer pass these checks, preserving broker records.
These rules do not supply overnight prices absent from the market-data provider,
and bar resolution must not be interpreted as the age of the latest price.

Missing cash-flow evidence makes affected P&L unavailable. Unknown is not zero.
See [NAV history](../architecture/unified-nav-history.md) and
[performance calculations](../architecture/performance-metrics.md).

## Ledger settlement currency

Campaign policy, diluted cost, capital recovery, and trade attribution convert
each cash amount in its recorded settlement currency. A security's quote
currency and the account's headline currency do not determine that currency.
Totals, fees and broker results retain their original values; GBP analytics
carry separate conversion evidence. Pence convert at 100 GBX per GBP.

Trading 212's CSV `Total` is the settled cash amount including conversion fees.
Net buy outflow, sale proceeds, dividend cash and closed-campaign P&L use those
totals without adding or subtracting the fee again. The separate fee is a
breakdown: pre-conversion-fee buy/sell amounts and trading results are derived
only when its GBP value is known. This does not claim to remove other taxes or
charges. Missing fee-conversion evidence leaves those breakdowns unavailable
while preserving independently known net cash and net P&L.

Where a broker record proves a GBP conversion, that rate takes precedence.
Otherwise the conversion uses the most recent completed daily FX close
available before the event, no more than seven days old. These historical
marks are estimates, not the broker's execution rate. Rates are cached outside
the checkout and record their source and availability time. Missing currency
or reliable FX makes only dependent monetary metrics unavailable; current
broker valuations, quantities and independently valid account metrics remain
visible. Unknown amounts are never replaced with zero.

Imported CFD cash flows, realised results and the cash-equity proxy follow the
same GBP conversion rule. A missing conversion cannot silently remove CFD
from the household total or reuse an older known amount. Raw imports remain
unchanged. If an import omits the net result and the fees needed to derive it,
dependent amounts also remain unavailable (`monetary_data_unavailable`);
a gross result alone cannot establish the net result.

CFD financing and dividend events count once. Direct trade links take priority;
position-level costs with matching holding periods are allocated by closed
quantity. This is Trading Max's attribution method, not a broker-reported
per-close allocation. Costs without a supported trade association stay in an
explicit unallocated bucket, so every attribution dimension reconciles to total
realised P&L. Conflicting embedded and standalone cost evidence makes affected
results unavailable pending reconciliation. Remaining open quantity requires
executed-order evidence; a cost row's quantity alone does not establish it.
Foreign CFD conversions use a GBP precision of 0.00000001 with half-even
rounding. Allocation puts any rounding remainder into the final share, keeping
each converted event total unchanged.

## Cash-flow verification diagnostics

Data status counts retained valuation points in the current immutable snapshot
that lack verified cash-flow coverage at each account's observation time.
The count is unrelated to the number of successful refresh jobs or chart gaps.
Both schedules report the same snapshot coverage. An unavailable count means
there is no readable snapshot or valuation history. `no_snapshot` identifies
an installation without a published snapshot; zero with no retained points
means a successfully read, empty history.
Cash-flow coverage alone does not certify intraday time-weighted returns.

## Interpret missing, historical, and modeled values

A missing reading may mean the provider does not cover it, the history is too
short, or the method is not applicable. Open help, source records, or Data status for
the relevant reason. A current quote does not update an immutable saved model.

Valuation ranges, seasonality, and option-derived estimates depend on their
inputs and conventions. They help inspect assumptions and history; they do not
certify future outcomes. This software does not provide investment, tax, legal,
or brokerage advice.
