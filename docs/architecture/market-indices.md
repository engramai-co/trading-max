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
| FTSE All-World | No licensed index quote is configured, so it is listed only in catalog and search. `VWRP.L` is a separate GBP ETF price series; it is never spliced into index points. |

The DAX feed is the [total return index](https://stoxx.com/index/dax/). VIX is an implied volatility measure
in volatility points; it is not a price or total return benchmark. Index prices
and ETF listing prices are distinct even if both use the price basis.
The ETF research layer links an issuer-confirmed benchmark label to the
registry's canonical family ID. That link does not equate the fund's benchmark
variant to the displayed index variant. Unknown and hedged variants do not
inherit an unhedged mapping by name.

Hong Kong session moves require a daily close dated to the previous
exchange session. The monitor reuses the daily bars it fetches for sector ranks.
When that exact close is missing, the constituent remains unpriced.

## Markets page reads

The US, Europe, UK, Hong Kong, Korea, Japan, Taiwan, India, Canada and Australia
have index cards and sector boards. Switzerland shows its index card; Swiss
constituents remain part of the Europe board. China A (`/sectors?market=cn`)
shows the CSI 300, SSE Composite, Shenzhen Component and ChiNext indices in
CNY. These indices follow the Shanghai calendar (09:30–11:30 and 13:00–15:00
China Standard Time). The lunch break retains the last morning reading. Beyond
the holiday coverage of the calendar dependency, the cards report dated
observations and the map omits the unverified move.

| China A index | Yahoo symbol | History ranges verified on 13 November 2026 |
| --- | --- | --- |
| CSI 300 | `000300.SS` | 1D, 1W, 1M |
| SSE Composite | `000001.SS` | 1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y, All |
| Shenzhen Component | `399001.SZ` | 1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y, All |
| ChiNext | `399006.SZ` | 1D, 1W, 1M |

The CSI 300 and ChiNext daily and weekly chart requests return a single
current quote. Yahoo carries roughly one year of hourly observations for both,
but the last bar of each past session is not a verified daily close. The
catalog therefore offers up to 1M for these two. The dated daily series
supplies the previous close when available. Otherwise the matching Yahoo
Spark session supplies the previous close. After the China A session ends,
the matching Spark session supplies the close before falling back to daily
bars, which can lag.
The four index cards load on demand in the existing shared intraday and daily
batches, reusing the map's cached CSI 300 quote where possible.
Global groups six benchmarks above a choice of Regions and Sectors. Japan's
sector board uses IJPN's MSCI Japan holdings on the Tokyo Stock Exchange; the
Nikkei 225 and TOPIX ETF cards use their own prices. The index cards and sector
board load and report freshness independently.

Europe's board uses [SMEA's MSCI Europe holdings](https://www.ishares.com/uk/individual/en/products/251861/ishares-msci-europe-ucits-etf-eur-acc-fund),
including the UK and Switzerland. Sector and industry group areas and portfolio
exposure use the full equity basket. Price requests take the largest European
listings up to at least 95% of basket weight; the tail and any US listings
contribute weight and exposure only. Returns are in each listing's local
currency. The Xetra calendar sets the board session (normally 08:00–16:30
London, with no lunch break); the board settles when closing prices cover
80% of basket weight. A listing closed for a local holiday contributes no
price for that day. Industry groups use available GICS matches in the local
security master.

The 12 November 2026 holdings check mapped 383 equity listings. Cash and
derivatives were skipped; a Kesko subscription right had no GICS sector and
was excluded. Yahoo Spark returned usable prices for all mapped listings.
The refresh sample was 289 names (95.04% of equity weight), or up to 15
batches per slot. Europe now polls every 30 minutes during the session and
shares overlapping London prices with the UK board.

The four additional boards use these iShares UCITS ETF holdings. Counts and
sample weights are from the issuer's 12 November 2026 holdings, after excluding
cash, derivatives and residual zero-weight equity lines. The displayed index
cards are separate local benchmarks; their returns are not the fund's returns.

| Board | Holdings source | Equity basket | Quoted sample | Local session | Spark requests/session |
| --- | --- | ---: | ---: | --- | ---: |
| Taiwan | [ITWN](https://www.ishares.com/uk/individual/en/products/251878) | 74 | 74 (100%) | TWSE and TPEx, 09:00–13:30 | 132 |
| India | [NDIA](https://www.ishares.com/uk/individual/en/products/297617) | 165 | 134 (95.08%) | NSE and BSE, 09:15–15:30 | 161 |
| Canada | [CSCA](https://www.ishares.com/uk/individual/en/products/253721) | 80 | 80 (100%) | TSX, 09:30–16:00 | 180 |
| Australia | [SAUS](https://www.ishares.com/uk/individual/en/products/251851) | 43 | 43 (100%) | ASX, 10:00–16:00 | 126 |

Taiwan keeps exchange-listed and OTC listings distinct (six TPEx lines,
`.TWO`, in this holdings file). The
[2026 TPEx calendar](https://dsp.tpex.org.tw/storage/eb_data/11411/114007545811-1.pdf)
matches TWSE's cash-equity schedule; the shared calendar applies the published
[TWSE 2027 closures](https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=html)
missing in the calendar dependency. Canada uses the
[TSX trading calendar](https://www.tsx.com/en/trading/calendars-and-trading-hours/calendar)
and Australia the [ASX cash calendar](https://www.asx.com.au/markets/market-resources/trading-hours-calendar/cash-market-trading-hours/trading-calendar.),
including their early closes. NDIA uses both NSE and BSE lines; prices
are never substituted across venues. The 95% target limits prices only.
The complete basket still determines map area and look-through exposure.

The India cash-equity calendar implements the
[NSE 2026 holidays](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf),
[BSE holidays](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20251212-8),
and the added January 15 municipal election closure
([NSE](https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf),
[BSE](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20260112-8)).
The February 1 Union Budget session follows regular hours
([NSE](https://nsearchives.nseindia.com/content/circulars/CMTR72349.pdf),
[BSE](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20260116-33)).
The November 8 Muhurat session is 14:20–15:30 IST
([NSE](https://nsearchives.nseindia.com/content/circulars/CMTR76941.pdf),
[BSE](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20261019-9)).
Outside the verified year, the board retains its last snapshot and pauses
scheduled refreshes. Index cards show provider-dated observations and mark the
calendar unknown; Global omits the unverified local move from its estimate.

A normal full-session estimate for automated boards is about 3,040 Spark
requests before these changes and about 2,660 after, allowing for overlapping
UK/Europe listings in the same polling slot. The four new boards account for
599 of the latter total. Without cache hits the corresponding counts are
3,210 and 2,723. Estimates include initial and closing daily reads with
successful data; retries and page-driven index/detail traffic vary with use.
US and India refresh every 20 minutes, Europe every 30 minutes and the
other boards every 10 minutes. Opening and settlement take priority, with
markets of the same priority rotating. All market reads share a budget of
64 requests per rolling minute and 3,200 per rolling day, with reserved
capacity up to 96 and 4,000 for opening and settlement. A Yahoo 429 pauses
provider reads for 30 minutes while each market keeps its last known board
and flags delayed updates.

The index catalog is metadata only. Market summaries reuse one batched
intraday quote read and dated daily baselines. Successful open sessions
refresh at most every ten minutes per viewed market; a settled session is
reused until the next open. The daily close is requested again after the
closing auction settles. Composite indices, and Indian indices outside the verified calendar year,
report provider-dated observations without claiming an official close;
those reads are limited to once every 30 minutes unless a listed index in
the same scope is trading. A shared listing cache coalesces overlapping basket
and card reads and pauses all those requests on a provider rate limit. The
catalog advertises each index's available ranges. One day uses five-minute
quotes, one week uses half-hour bars over seven days, and one month uses hourly
bars over a calendar month. Longer windows reuse the cached daily series.
MSCI World ex USA, EM and EM IMI use the 17:00 New York hourly bar for daily
values up to one year. All uses completed weekly bars across the available
history and dates each bar at the end of its provider period.

Intraday GBP conversion matches the latest FX bar at the same frequency.
Daily and weekly conversion uses the most recent prior FX close at that
frequency. Comparisons require the same kind, return basis and displayed
currency. They rebase to 100 at the first shared time slot, day or calendar week.
Unreported prices remain empty; a dotted line bridges known gaps. Weekend
placeholders do not count as gaps for daily composite indices. Drawdown and
annualised volatility use daily bars for daily ranges and weekly bars for All.
For one week and one month, drawdown uses the chart bars and annualised
volatility uses the last reading of each completed weekday.

The S&P 500 and FTSE 100 details reuse the published sector board as a
constituent basket. The Nasdaq 100 uses [CNDX](https://www.ishares.com/uk/individual/en/products/253741/ishares-nasdaq-100-ucits-etf-cndx);
that basket refreshes at most every 15 minutes when viewed, caches completed
baselines and reuses overlapping US listing quotes. A missing basket can
backfill after hours at most three times per session, an hour apart. MSCI Japan shows the
published IJPN weights; its quote and contributions remain unavailable. Basket
contributions multiply each quoted holding's weight by its return; missing
weights are not renormalised. A residual appears only when both observations
refer to the same session and are within five minutes. The held ETF panel
joins issuer-confirmed benchmarks to the same immutable broker snapshot by
ISIN, then sums position value across accounts. A link to the ETF's holdings
lens opens the look-through.

## Global contribution

`GET /v1/indices/global-contribution` returns public, portfolio-independent
market moves and an estimate of each market's contribution to MSCI ACWI.
The latest official close is identified from the benchmark's five-minute
history, checked against the dated daily series and the provider's previous
close. Its observed timestamp, not a fixed hour, separates global trading days.
Before any tracked exchange opens after that close, the page shows the most
recent completed day, including on weekends. Once a tracked exchange opens,
ACWI is measured from that close, and markets with no session in the window
show zero and remain neutral on the map. The page names the reference day.

The endpoint reads the main indices in batches through the price cache shared
with market tabs. A quote that cannot be matched to the reference session is
omitted and disclosed as partial coverage. The response is cached for four
minutes.

Country weights are aggregated from the equity locations in the
[iShares MSCI ACWI UCITS ETF (SSAC)](https://www.ishares.com/uk/individual/en/products/251850/ishares-msci-acwi-ucits-etf)
holdings, with no renormalisation. The dated aggregate is cached for seven days
using the issuer holdings source shared with the sector boards. If refresh
fails, the last aggregate is retained and identified as stale. The developed
market rows use local index moves, including STOXX Europe 600 for core Europe
and the Nordics. The emerging market row uses the USD move of MSCI EM.
China, Korea, Taiwan, and India show their local moves on the map while their
contributions stay in the emerging market row. China adds only the CSI 300
symbol to the existing daily and intraday batches, with no extra Yahoo request
at the current batch size. China’s tile in the Overview map uses the whole
China country weight in MSCI ACWI, including offshore listings and the China A
fund holdings. Its colour represents the CSI 300’s move in CNY.
“Currency and other” is ACWI minus the sum of priced contributions; it includes
FX, unlisted or missing markets, and proxy and observation-timing differences.

The map uses [Natural Earth 110m](https://www.naturalearthdata.com/about/terms-of-use/)
in Equal Earth projection, with the southern polar region omitted. The wide
layout also crops the outer Pacific margins to give more space to the land.
Both layouts preserve the projection’s proportions. Run
`uv run python tools/generate_global_market_map.py` to regenerate the static
paths from the pinned, checksum-verified source. No geography package or
download is needed at runtime.

## Global sector indices

Markets opens on Global unless a market is named in the URL. The Global
Regions view retains the ACWI contribution map. `?view=sectors` keeps the
same benchmarks and reference clock while showing the MSCI World (developed
markets) sector board. The desktop demo discloses that both views have no
quote data.

`GET /v1/indices/global-sectors` returns the reference date, phase and as-of
time shared with Global contribution. The public board is computed on demand
and cached for four minutes. The [industry index registry](../../backend/src/trading_max/reference/msci_world_sectors.py)
identifies MSCI's USD price indices by GICS code. Five-minute observations and
daily closes are batched through SharedMarketPrices. For the few symbols
whose Yahoo daily feed lacks dated history, the Yahoo chart feed's carried
official marks can corroborate closes. The board uses the prior official
close as its baseline and caps all observations at the shared reference time.
Ranks compare the last five completed sessions. Unconfirmed moves and
ranks stay empty; missing sector quotes keep their weight and a neutral
tile. Industry groups with no verified index quote are omitted from the rail.

Tile area and top constituent weights use GICS equity holdings in
[iShares Core MSCI World UCITS ETF (SWDA)](https://www.ishares.com/uk/individual/en/products/251882).
The dated public aggregate is cached for seven days, with a stale indicator
if the previous good result is retained. A sector's estimated contribution
to MSCI World is its share of fund NAV times its index move; weights are not
renormalised. The help popover records the basis and holdings date.
Constituents are displayed by name and weight without requesting their prices.
Portfolio exposure is read independently of the public cache from the latest
immutable portfolio look-through industry allocation across all accounts.

## Index depth

The existing `GET /v1/indices/{id}/context` response includes saved breadth,
VIX context and valuation when available. It does not fetch inputs or
calculate those statistics during a request. The market monitor, when enabled
by the research schedule, updates the snapshots after its ordinary quote
work. The local cache is under `<data-root>/state/indices/depth-v1/`. A later
unavailable session leaves the previous reading visible and marked stale.

**Breadth.** S&P 500 (CSPX), Nasdaq 100 (CNDX), FTSE 100 (ISF) and MSCI Japan
(IJPN) use their existing iShares equity baskets. The chart shows up to 252
exchange sessions, recalculated against one dated basket; this is a
current-basket back-calculation with survivorship bias. Each listing counts
once. A listing must have that session's close and 50 or 200 observed daily
closes within the last 53 or 210 exchange sessions, including the reading
session. Breadth is the fraction of eligible listings strictly above their
simple average. Eligibility is shown separately for each window; readings
with less than 80% of basket members eligible are missing. Holidays and
weekends are omitted, genuine gaps have dotted connectors, and missing prices
are never carried forward. Closes use listing currency.

The initial fill uses two years of daily Spark closes in 20-symbol batches.
The 12 November 2026 holdings contained 503 CSPX, 101 CNDX, 100 ISF and 167
IJPN equity listings, with 86 listings shared by the US baskets. That is
26 US + 5 UK + 9 Japan = **40 Spark calls** for an empty cache. After the
fill, the monitor reuses the settled daily closes it already collects for the
boards and the shared short cache. Only the 15 CNDX-only lines need a
separate one-month batch in the ordinary case (**1 Spark call per US
session**); missing settlements can add batches. New members, revised
overlapping prices (e.g. a split) and offline gaps longer than the short
cache require a new long series for affected listings. A changed ISIN also
invalidates the cached ticker history. A normal refresh adds no issuer call
for CSPX/ISF/IJPN when their existing 20-hour caches are fresh; CNDX moves
from view-only refresh to one shared holdings read per session when needed.
All new Yahoo reads share the MKT-2 ordinary limits of 64/minute and 3,200/day,
its higher-priority reserves remain available for board opening and
settlement, and a provider 429 pauses the same shared cache. Failed or
incomplete work has up to three hourly attempts per session per market.

**VIX.** US details compare the latest completed Cboe VIX close with earlier
daily closes over roughly five years. The response gives the empirical
percentile (share at or below that close), the 10th–90th percentile range, the
sample dates and size, and the data retrieval time. Close and range are in
volatility points. This reuses the existing Yahoo `^VIX` daily chart cache
and takes at most one chart call per successful session on a cache miss.
Intraday marks are excluded.

**Valuation.** Selected MSCI and iShares source pages are linked without
automated retrieval. When the workspace operator has the right to use a
provider or issuer snapshot, place one dated JSON record in
`<data-root>/reference/index-valuations/<index-id>.json`; leave any
unpublished metric out. Replace the file as the source updates. The index
registry binding determines the provider, link and whether the reading
represents an index or a tracking fund portfolio. The UI shows only that
snapshot and its date, with no inferred forward P/E or valuation history.
Synthetic file example:

```json
{
  "asOf": "2026-10-30",
  "fetchedAt": "2026-11-01T12:00:00Z",
  "pe": 22.5,
  "forwardPe": 18.6
}
```

**Data and rights.** The private workspace reuses the existing Yahoo
compatibility path and iShares holdings caches; neither ships data or grants
a feed licence. [Yahoo terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)
require express permission for automated access; use the integration only
where the applicable terms and permissions allow it.
[iShares terms](https://www.ishares.com/uk/individual/en/compliance/terms-and-conditions)
restrict copying and redistribution. [Cboe history](https://www.cboe.com/tradable-products/vix/vix-historical-data/)
and [FRED VIXCLS](https://fred.stlouisfed.org/series/VIXCLS) are reference
sources only; the FRED series is Cboe copyright and is reprinted with
permission. No new feed is added for either.

[MSCI index terms](https://www.msci.com/legal/index-terms) do not grant
automated copying or redistribution rights for public factsheets. Index
historical membership is omitted: public change announcements do not supply
a complete, authorised point-in-time membership series. Nikkei also publishes
a [component change archive](https://indexes.nikkei.co.jp/nkave/archives/file/history_of_nikkei_stock_average_component_changes_en.pdf);
it is a reference and is not republished or used to build an in-app series.
[S&P DJI](https://www.spglobal.com/en/terms-of-use) publishes selected
constituent changes; the Dow's effective divisor is distributed through
its end-of-day index files. [Nikkei](https://indexes.nikkei.co.jp/nkave/data/index.en.html)
publishes the divisor and constituent information for reference. Its licensed
data package supplies daily calculation inputs, including corporate actions
and next-session base prices, for a reproducible series. The application
publishes no price-weighted attribution for either index.
[Hang Seng Indexes](https://www.hsi.com.hk/solutions/data-analytics/)
offers index and constituent licences, and [KRX](https://global.krx.co.kr/contents/GLB/01/0103/0103010000/GLB0103010000.jsp)
has a separate index licensing business. The Hang Seng and KOSPI details show
the existing MSCI sector-board baskets explicitly as proxies, with no
benchmark attribution and no claim to use official weights.
