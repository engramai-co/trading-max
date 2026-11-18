# Research stocks, funds and indices

[Documentation](../README.md) · [Data conventions](data-and-metrics.md)

Research works independently of your portfolio refresh. Start from a holding
or open **Search** (the magnifier at the top of every page, or ⌘K / Ctrl K).
Stocks, funds and indices in your research list open directly. For any other
listing, choose **Find in all securities**, or search from the research list
itself: fuzzy matching proposes up to three listings, and matching indices
appear as you type. Open a result, confirm the ticker and exchange, then choose
**Add to research list**. Similar names can refer to different listings.

The list's pin keeps the list beside the workspace on a wide screen. It pins
the list layout, not the selected company. **Compare** opens a company
comparison, and the ··· menu changes a category or removes an entry from the
research list. Holdings always stay in the list.

With the keyboard, the arrow keys, Home and End move between the views below;
Enter or Space opens the one in focus.

## Choose the question first

| View | Use it to… |
|---|---|
| Overview | See the company, a fixed three-month candlestick preview, operating facts, upcoming disclosures, and your exposure |
| Financials & business | Read statements, operating trends, segments, ownership, and dividends |
| Price & technicals | Inspect the price chart, technical readings, or seasonality in separate sections |
| Estimates & events | Compare reported results with expectations and inspect available rating/event history |
| Valuation | Test and save your own operating assumptions |
| Options | Inspect available captured chains and derived structure |
| Journal | Keep notes, model versions, and filing evidence together |

Availability varies by listing and provider. A fund, a bank, and an operating
company will not have the same datasets or applicable models.

## Research an index or a fund

Indices are a research type of their own. Open one from **Markets** or search
for it in Research; both lead to the same index. **Add to research list** keeps
it in the research list beside stocks and funds; indices are kept in this
browser. Its views cover the overview,
price and history, constituents with breadth and contribution, and the funds
that track it. Funds are grouped by how closely they follow the index: the same
benchmark first, then the same family, then similar exposure. Your own exposure
to the index's constituents is shown on your screen and is never written into
the link.

Comparisons need the same currency, return variant and hedge basis, and allow
up to three series from their first common observation. Long histories can use a
log scale, with drawdown and rolling volatility beneath. Some index families
require a licensed data source; the page says so rather than substituting a
different series.

A fund's research shows its one-year tracking difference: the share class's NAV
total return minus the benchmark return its issuer discloses. Daily tracking
difference and rolling tracking error need the issuer's daily NAV and benchmark
file, imported into your workspace where the issuer offers one; see
[market indices](../architecture/market-indices.md). A premium or discount
appears only when the market price and NAV carry the same timestamp. US ETFs
that resemble a fund you hold can be opened read-only before you add them to
the research list.

An optional EODHD key in **Settings** adds native daily history for TOPIX, Hang
Seng TECH, CSI 300 and KOSPI 200. It is off until you add a key.

## Follow the financial evidence

Choose Annual, Quarterly, or TTM and a reporting period before comparing
numbers. TTM is a trailing four-quarter measure, not an annual forecast.
Income, balance-sheet, and cash-flow views keep different financial concepts
separate. **All reported rows** and source details let you inspect the underlying
records when the summarised view is not enough.

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
moving averages; Technicals opens on candles. The company overview stays a fixed
three-month candlestick preview.

Every main chart shows its reading above the plot. Pointer, touch and the arrow
keys move the same selection, and sparse periods say how many observations they
hold. The event track below the price marks your trades, earnings, dividends and
splits, with several events on one day combined. Use the chart menu for
fullscreen, to copy the current reading, or to export CSV or PNG; exports use the
original observations and stay on your computer.

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

## Read expectations and events

The ratings section puts individual firms’ dated targets on the 12-month price
chart. The range at its right shows the current target snapshot. The page
continues with earnings estimates, the earnings calendar and institutional
actions. Use the section index beside the page or the strip at the top on a
narrow screen to jump directly to a heading.

## Work through a valuation

1. **Read the starting figures.** The top row shows trailing P/E and its
   historical rank, the operating assumption implied by the price, and the
   base scenario. The implied input can be revenue growth, target margin or
   year-one ROE. A bound shows where the price falls outside the tested range.
   A dash and “No unique estimate” mean the model could not isolate one input.
   Companies reporting zero revenue show the year-five revenue required under
   the stated margin and exit multiple.
2. **Inspect historical valuation.** Switch between trailing P/E, NTM P/E
   and filing-date P/S. The section index leads to the scenario model,
   sensitivity and worksheet when projections are available.
3. **Compare the scenarios.** Bear, base and bull use different assumptions
   over five or ten years. Compare their per-share values with the current
   price, and check the statement period and share basis under Operating reference.
4. **Adjust assumptions.** The desk selects equity cash flow for operating
   companies, net income for brokers and trading platforms, and residual income
   for banks and insurers. Choose a different model in **Adjust assumptions**.
   For residual income, edit year-one ROE, payout, cost of equity and terminal
   P/B. Enter percentages as displayed, such as 5 for 5%.
5. **Inspect sensitivity and the worksheet.** The grid varies growth or ROE
   against cost of equity. The worksheet shows annual projected amounts and
   the contribution of terminal value.
6. **Save a version and a reason.** Each version preserves its inputs and
   evidence. Under **Journal → Model versions**, set a saved version as the
   baseline to compare its five-year base value with the latest batch price
   in Overview. Clearing the baseline restores the automatic valuation.

The model contract describes the formulas, period selection, currency
conversion and share-unit checks. [Model contract](../architecture/valuation-model.md)

For covered US listings, **Trailing P/E** pairs the Yahoo daily close (adjusted
for splits, excluding dividends) with SEC Companyfacts diluted EPS on the same
share basis. A filing enters the series at the first regular close after EDGAR
acceptance. The denominator uses filed annual EPS at fiscal year end when
available; otherwise it adds four consecutive quarters. An unreported fourth
quarter is inferred from annual EPS minus the first three quarters. Later
restatements apply from their own acceptance times. Missing closes, incomplete
earnings windows, and nonpositive EPS leave gaps.

The shaded band shows the 25th to 75th percentiles with the median dashed.
Switch to **Mean ±1σ** for the mean and one population standard deviation.
The rank beside the latest close counts valid daily observations at or below
that multiple. Both references require 60 valid closes. Hover, tap, or use the
arrow keys on the chart to read its dated inputs. The annual P/E filing points
remain available under **Valuation at disclosure** in historical valuation.

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
