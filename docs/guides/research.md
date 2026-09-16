# Research a security

[Documentation](../README.md) · [Data conventions](data-and-metrics.md)

Research works independently of your portfolio refresh. Start from a holding
or choose **Add security** in the research list. Search by ticker or company
name; fuzzy matching proposes up to three candidates. Confirm the ticker and
exchange before adding one. Similar names can refer to different listings.

The list's pin keeps the list beside the workspace on a wide screen. It pins
the list layout, not the selected company. Comparisons and watchlist management
are available alongside the research list.

## Choose the question first

| View | Use it to… |
|---|---|
| Overview | See the company, a fixed 3M closing-price line, operating facts, upcoming disclosures, and your exposure |
| Financials & business | Read statements, operating trends, segments, ownership, and dividends |
| Price & technicals | Inspect the price chart, technical readings, or seasonality in separate sections |
| Estimates & events | Compare reported results with expectations and inspect available rating/event history |
| Valuation | Test and save your own operating assumptions |
| Options | Inspect available captured chains and derived structure |
| Journal | Keep notes, model versions, and filing evidence together |

Availability varies by security and provider. A fund, a bank, and an operating
company will not have the same datasets or applicable models.

## Follow the financial evidence

Choose Annual, Quarterly, or TTM and a reporting period before comparing
numbers. TTM is a trailing four-quarter measure, not an annual forecast.
Income, balance-sheet, and cash-flow views keep different financial concepts
separate. **All reported rows** and source details let you inspect the underlying
records when the summarized view is not enough.

In **Segments**, use **Size & mix** for total revenue and composition, and
**Segment trends** to follow a business through time. Shares are shown only
when the segment totals reconcile. Large values use compact units; exact
records retain full precision.

In **Ownership & dividends**, completed annual dividend totals and trailing
twelve-month totals avoid comparing an unfinished year with full years.
Current YTD is compared with the matching prior-year cutoff separately.
In the share-count view, period-end shares and weighted-average shares answer
different questions; use the labelled EPS basis to compare weighted basic and
diluted shares.

## Use the chart at the level you need

The ordinary **Chart** section offers a range, line/candles, volume, and optional
moving averages. The company overview stays a simple fixed 3M preview.

A candle's body runs from opening to closing price; the wick reaches the high
and low of that bar. A daily candle and a 15-minute candle cover different
intervals. The displayed history may be shorter than requested when the
provider lacks older intraday bars.

Open **Full chart** for interval selection, linear/log/return-percentage scales,
benchmarks, RSI, MACD, moving-average periods, and zoom. A log axis compares
proportional moves and requires positive prices. Return % mode compares changes
from a common starting point. Neither adds missing market observations.
Close the full chart or press Escape to return to the ordinary view.

**Technical data** groups performance and price levels, momentum/trend,
volatility, and volume/relative performance. These readings use completed daily
bars. They need not match an indicator calculated on intraday candles.
RSI, moving averages, and MACD describe the observed series; none is a guaranteed
buy or sell instruction.

**Seasonality** combines month-by-year returns with within-year paths. Choose
the history window, mean or median, and years to compare. Check sample counts:
an incomplete month is excluded and a short history can change the result.

## Work through a valuation

1. **Check the operating reference.** Review revenue, cash flow, shares,
   currency, and source period. If the model is unavailable, read its reason.
2. **Compare the scenarios.** Conservative, base, and optimistic are sets of
   assumptions. Their gap to the current price is a model comparison, not a
   forecast of your investment return.
3. **Choose five or ten years.** This changes the explicit forecast horizon,
   and recalculates through the same model.
4. **Change one assumption.** Select a scenario and then growth, cash-flow
   margin, cost of equity, terminal multiple, or share-count change. Enter
   percentages as displayed—for example, 5 means 5%, not 0.05%.
5. **Inspect sensitivity and the worksheet.** Sensitivity shows how the value
   changes when assumptions change together. The annual projection shows what
   revenue, cash flow, and shares the assumptions produce.
6. **Save a version and a reason.** A saved model preserves its inputs and
   evidence. Editing a model creates a new saveable state; it does not rewrite
   an older version. Find them under Journal → Model versions.

The current method discounts an equity cash-flow proxy. It is not a verified
enterprise-value model, and it does not simply subtract debt from its output.
Banks and other unsupported businesses can be unavailable. Analyst price
targets do not fill missing scenario values. See the
[model contract](../architecture/valuation-model.md) for the exact method.

## Read options without confusing observations and estimates

Select captured expirations, then use the chain or one of the structure views.
Historical mode uses stored captures; it cannot retrieve arbitrary past chains
that were never collected.

| View or field | What to look for |
|---|---|
| Paired chain | Calls and puts at each strike, bid/ask, volume, and open interest |
| Implied volatility | How option-implied volatility differs by strike and expiry |
| Open interest | Outstanding contracts; distinct from today's traded volume |
| Gamma estimate | A model under a declared position-sign convention, not observed dealer inventory |
| Expiry payoff | A hypothetical expiration payoff under the selected assumptions |

Wide bid/ask spreads and stale quotes can make a point look more precise than
it is. Open interest is not a signed position and does not reveal who owns the
contract. Gamma walls, flip points, and max-pain calculations are derived
descriptions, not guaranteed price destinations. Inspect the capture date and
convention before comparing readings.

## Keep your conclusion with its evidence

Use the journal to record what would change your view and link it to model
versions or available filings. A saved model's quote and operating evidence
stay frozen; the current company header can move on. This makes a later review
of earlier reasoning possible without silently replacing its inputs.
