# Market indices and benchmarks

[The index registry](../../backend/src/trading_max/reference/indices.py) records
the compiler and its identifier, the exact display basis and currency, the
Yahoo-compatible symbol, the calendar and the supported daily history. Five
years means the requested maximum; individual series may have shorter or
incomplete coverage. A zero daily horizon does not imply a zero return. MSCI
and STOXX composite calendars are descriptors, not local exchange schedules.
No China A-share sector board is registered; global benchmarks retain their
published constituents, which can include A shares.

The software license does not cover prices, histories, or index data. The
registry identifies provider terms and series that need a licensed source.
This private workspace uses its existing Yahoo-compatible integration. It
does not bundle quotes, republish feeds, or grant redistribution rights. See
[Yahoo's terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) and the
relevant compiler's terms. The MSCI public index charts are reference evidence,
not a historical feed for this feature.

| Benchmark | Displayed fallback |
| --- | --- |
| TOPIX | The Nomura ETF listing `1306.T`, labelled **TOPIX ETF price**, in JPY. |
| Hang Seng TECH | The iShares ETF listing `3067.HK`, labelled **Hang Seng TECH ETF price**, in HKD. |
| FTSE All-World | The index quote has no configured daily history. `VWRP.L` is a separate GBP ETF price series; it is never spliced into index points. |

The DAX feed is the total return index. VIX is an implied volatility measure
in volatility points; it is not a price or total return benchmark. Index prices
and ETF listing prices are distinct even if both use the price basis.
The ETF research layer links an issuer-confirmed benchmark label to the
registry's canonical family ID. That link does not equate the fund's benchmark
variant to the displayed index variant. Unknown and hedged variants do not
inherit an unhedged mapping by name.

Hong Kong session moves require a daily close dated to the previous
exchange session. The monitor reuses the daily bars it fetches for sector ranks.
When that exact close is missing, the constituent remains unpriced.
