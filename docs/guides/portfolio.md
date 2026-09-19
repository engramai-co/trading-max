# Understand your portfolio

[Documentation](../README.md) · [Data conventions](data-and-metrics.md)

## Begin with account scope

Overview combines investing accounts and shows value, unrealized P&L,
daily return, allocation, and account summaries. Use the account selector to
inspect an individual account. Invest and Stocks ISA remain distinct records
even when the same security appears in both.

Historical CFD records, where imported, are a separate realized-cash proxy.
They are not reconstructed CFD positions and do not enter investing strategy
risk statistics.

## Positions and exposure answer different questions

In **Holdings & exposure → Your positions**, filter or sort the securities your
broker reports. Open a position for its account detail and research link.

Switch to **Look-through exposure** to inspect the underlying companies and
allocations inside supported funds alongside direct holdings. This can reveal
that several apparently different funds hold the same companies. An unresolved
portion remains unresolved; a missing fund dataset is not a zero exposure.

In country, industry and GICS rankings, names wrap in full. Each bar's full
background represents 100% of the allocation; the blue fill and percentage
use the same scale. Switch to **Composition** and select a ring slice or a
category name to keep its GBP value and weight visible. Small slices also have
large list targets; **Other categories** expands the remaining breakdown.
Arrow keys, Home and End select categories when the ring has focus.

## Read money and P&L

In **Performance & risk → Money & P&L**, select an account and time range. The
four headline measures use one basis across short and long ranges:

| Measure | Meaning |
|---|---|
| Ending value | The last account value in the selected interval |
| Net contributions | External deposits minus withdrawals during that interval |
| Period net P&L | Ending value minus opening value minus net contributions |
| Maximum P&L drawdown | Largest fall from the running peak of period P&L |

For example, an account that starts at £10,000, receives £1,000, and ends at
£11,500 has £500 of period P&L. Its £1,500 value increase includes the deposit.
This example explains the arithmetic; it is not a live account record.

The currency/% control changes the unit. **From opening %** uses the positive
opening account value as its denominator; it is not time-weighted return.
When cash-flow evidence is incomplete, the app can still show value history
but cannot certify the missing P&L. Open the title's help or exact records when
you need the basis behind a point.

The overview shows period net P&L from zero, using the same accounting cutoff
as this detailed performance view. The detailed page also shows account value,
cumulative net contributions, and P&L drawdown.

| Range | Display interval |
|---|---|
| 1D | 10 minutes |
| 5D | 30 minutes |
| 1M | 1 hour |
| 3M | 2 hours |
| 6M | 4 hours |
| YTD | Follows elapsed span, becoming daily beyond six months |
| 1Y / All | Daily |

5D means five London weekdays; monthly ranges retain calendar-month boundaries.
Weekends are folded in the display. Display sampling does not reduce the
precision of P&L and drawdown calculations. Earlier daily-only data stays daily.
A dashed connector spans a display interval without any usable observations;
it does not invent intermediate values. Exact records retain their source and
original gaps.

## Compare return and risk

**Return comparison** uses the reconciled daily performance path to compare
cash-flow-adjusted returns and supported benchmarks. Check that the account,
range, and currency are the ones you intend to compare.

**Risk profile** adds drawdown and risk readings. Ratios need enough valid
observations; an unavailable Sharpe or Sortino is not zero risk. Money P&L,
unrealized position P&L, and a cash-flow-adjusted return are distinct measures.

## Review and refresh

Review shows available account and realized-trade evidence. Realized attribution
requires matched opening and closing records. Historical imports may have less
coverage than current positions.

Use **Data status → Start update** to request a full update and follow the job.
A request being accepted does not mean it has finished. On failure, the last
published snapshot stays available. Check the failed stage before retrying.
Never remove the state directory to force a refresh.
