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

Short-range display buckets are 10 minutes (1D), 30 minutes (5D), one hour (1M),
and two hours (3M). Calculations use all stored observations before display
sampling. Longer ranges use daily values. Full overnight market coverage is
not guaranteed by the availability of pre/post-market bars.

Missing cash-flow evidence makes affected P&L unavailable. Unknown is not zero.
See [NAV history](../architecture/unified-nav-history.md) and
[performance calculations](../architecture/performance-metrics.md).

## Interpret missing, historical, and modeled values

A missing reading may mean the provider does not cover it, the history is too
short, or the method is not applicable. Open help, source records, or Health for
the relevant reason. A current quote does not update an immutable saved model.

Valuation ranges, seasonality, and option-derived estimates depend on their
inputs and conventions. They help inspect assumptions and history; they do not
certify future outcomes. This software does not provide investment, tax, legal,
or brokerage advice.
