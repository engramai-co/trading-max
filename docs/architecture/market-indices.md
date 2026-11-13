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

The US, Europe, UK, Hong Kong, Korea and Japan have index cards and sector
boards. Taiwan, India, Canada, Australia and Switzerland show indices only.
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
batches per slot. In a normal full session that adds up to 855 Spark requests
(55 intraday slots plus two daily reads) before shared UK cache hits. With
all 56 overlapping UK listings reused, batching order puts the marginal
count at about 684–741 requests. Failed, delayed or unsettled sessions may
use additional retries under the monitor's existing limits.

The index catalog is metadata only. Market summaries reuse one batched
intraday quote read and dated daily baselines. Successful open sessions
refresh at most every ten minutes per viewed market; a settled session is
reused until the next open. The daily close is requested again after the
closing auction settles. Composite and Indian indices report the provider's
dated observations without claiming a verified session or official close;
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
Korea, Taiwan, and India still show their own local moves on the map.
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
