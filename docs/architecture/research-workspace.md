# Research workspace

The 1.x workspace organizes real provider data into independent research lenses,
keeping broker ingestion and portfolio snapshots separate. See the
[user guide](../guides/research.md) for the workflow and the
[presentation contract](research-presentation.md) for chart responsibilities.

## Decisions

- Normalize financial periods and metric observations before presentation.
  Preserve provider fields and immutable snapshots; a financial metric is not
  interchangeable with an estimate, a model assumption, or a differently dated
  provider summary.
- Use one quote identity throughout each loaded research context. Keep saved
  valuations frozen, and make recalculation a separate preview operation.
- Organize research around company facts, financials, price, expectations,
  valuation, and evidence. Keep the options workspace available where supported.
- Add public disclosure evidence and real market datasets through backend
  adapters. Missing data never becomes synthetic market data. The preview may
  mock Trading 212 account ingestion only.
- Retain working statement, margin, earnings-surprise, revision and options
  views. Extend their periods, drill-through and context instead of duplicating
  them. Match each visualization to the question being answered.

## Compatibility and alternatives

New response fields and endpoints are additive. Old lens URLs continue to work;
the account snapshot contract and NAV collection schedule do not change.
Legacy artifacts remain readable and are normalized without overwriting them.
Directly copying competitor values, scraping paid datasets, rebuilding research
inside the broker snapshot, and replacing all charts with one chart type were
rejected: each loses either provenance, compatibility, or useful meaning.

## Privacy and migration

Provider caches, filings, portfolios, watchlists, notes and model runs remain in
the external state root. Private evidence is excluded from shareable URL state.
No credentials or real-account data belong in fixtures or Git. Existing preview
state is preserved and an isolated build is verified before changing its launcher.
Published releases preserve additive contracts and existing external state.
Operator-managed macOS upgrades retain the previous installed runtime for rollback.
New model versions and notes share one atomic journal store. Saving a research
model does not rewrite the older background valuation-assumption configuration.
The latest saved research inputs initialize the next preview, while the saved
quote, financial observations, growth references and worksheet remain frozen.

## Earnings estimate history

Successful scheduled research publications record Yahoo Finance valuation
fields and analyst EPS consensus for held and watched listings in the state
root's `trading_max.db`. The archive reuses the scheduled research fetches.
Scheduled research covers the watchlist plus every listing held in Invest and
Stocks ISA, without changing the saved watchlist. Each UTC
observation preserves the vendor's `forwardPE`, `forwardEps`, `trailingPE` and
`trailingEps`, plus any available quote and raw consensus periods (`0q`, `+1q`,
`0y`, `+1y`). The quote price is in pounds when the vendor quotes in pence;
vendor EPS and P/E fields keep their original values. The quote is a reference
price; Yahoo does not identify the calculation price for its P/E fields or
provide a separate estimate as-of time in these feeds. Fiscal-year estimates
are distinct from next-twelve-month estimates; the archive does not derive
either an NTM estimate or a P/E. Unavailable values stay null, and unavailable
or carried-forward provider results do not create observations.

The ledger appends changes from its first successful scheduled run, skipping
consecutive identical observations. A one-time pass may also recover fresh
rows from up to 32 recent research publications among the newest 2,048
snapshot manifests. Recovered observations are marked and use their original
publication time; missing or older history cannot be reconstructed from
current quotes. `GET /v1/research/{ticker}/estimate-history` reads the latest
observations for that exact listing, oldest first, with at most 2,000 rows.

## Validation

Synthetic domain tests cover period identity, cash-flow reconciliation,
currency conversion, sparse data and model reproducibility. API and UI checks
cover partial failures, research state, charts, keyboard and narrow viewports.
Repository checks run before the final local deployment. An issue is not closed
because a component exists: its stated data and interaction acceptance must pass.

## Research readings

With MaxAI enabled and consented, opening the sidebar on Overview reads the
selected listing. A verified Invest or ISA fill establishes the baseline at
that session’s close. The comparison measures a price change, independently of
the fill price and the position’s profit or loss.

The price chart requests up to three rule-ranked, event-backed sessions in its
visible daily range. The chart and event track open the same reading by date.
On phones the numbers appear in the track. A dated news item links directly to
its publisher and is a lead about the session. A reading is generated only on
selection. Published charts are pinned to their research artifact. External
daily charts and index charts use bounded local caches of the exact series
already served. An expired or mismatched identity yields no reading.

Financials and Estimates & events share a collapsed earnings brief when a
held or research-list company has a published reading matching the reported
results and dated consensus estimates on the page. The background writer
excludes intraday updates and deduplicates material revisions. Prices,
event dates, EPS units, currencies and estimates come from deterministic tools.

## Listing venue resolution

Use `trading_max.research.venues.resolve_venue(requested, *claims)` wherever
published or live evidence is matched to a listing. Pass the original requested
symbol, including its suffix. Each `VenueClaim(source, value, listing)` names
the namespace and the symbol to which the evidence belongs. `row_claims` builds
claims for a price row and its exact fundamentals. A provider symbol owns its
own exchange evidence. Joining separately owned rows requires an exact symbol
or an alias verified by the routing evidence. A common MIC alone does not identify a security. `watchlist_claims` handles
stored provider codes, legacy display names and the generated market default.

The result contains the compatible MICs in `venues`, a `conflict` flag and the
verified session `calendar` when available. Intersect explicit evidence,
including qualified symbols. Apply a market default only when its own symbol
has no explicit venue. A bare US request can therefore reject a different
London listing, while a stored default on a qualified London symbol yields
to that symbol. Nasdaq listing tiers have distinct MICs and share a schedule.
A consolidated US feed or a broker’s US share line can supply the regular US
session when no specific venue is known. An unknown provider code leaves
timed evidence without a calendar. Conflicting
verified claims make the price unavailable and withhold venue-dependent events.

Yahoo suffixes, Yahoo codes and names, OpenFIGI exchange codes and ISO MICs
have their own mappings. For example, OpenFIGI `BO` identifies B3 Soma, while
the Yahoo suffix `.BO` identifies Bombay. Issuer domicile, quote currency and
time zone do not identify the venue. Exchange provenance on new watchlist
entries is optional for compatibility with older snapshots. New price rows
retain the provider symbol, MIC and both exchange names. The chart checks the
same evidence for live OHLC, close-only history and published fund prices.

The namespace references are the [OpenFIGI exchange code list](https://www.openfigi.com/about/exchange-codes),
the [ISO 10383 MIC register](https://www.iso20022.org/market-identifier-codes)
and [Yahoo’s listing suffixes](https://uk.help.yahoo.com/kb/SLN2310.html).
Yahoo chart metadata supplies its exchange codes and display names.


### Every path that consults the resolver

`ResearchLedger.pin_listing` binds the requested ticker, routed ticker, exact
price-row ticker, held listing and venue claims to one snapshot. It checks the
raw technical and fund bars, the fund directory, the compact market quote and
the exact fundamentals. A held alias must identify one listing. The legacy
bare/London price-row fallback requires London evidence on the observed row
or its own watchlist entry. An exact observed New York row takes precedence
over a London watchlist alias. When both bar rows have been published and
the bare row retains its provider symbol, routing it to London requires
affirmative evidence on the bare listing. Intraday requests and independent event feeds
use the verified listing symbol even when an older snapshot stores its bars
under a bare key. Assistant runs freeze the routing inputs at startup. If the
watchlist is unreadable, their listing-dependent tools disclose the missing
routing evidence.

| Entry point | Evidence checked and resulting behaviour |
| --- | --- |
| Published daily price history | The selected technical or fund row supplies the series identifier, bar prices and original quote unit, including pence. The legacy technical publisher stored major units. A matching GBP or GBp source therefore corroborates GBP bars and dividends. An unqualified legacy compact USD default supplies no London currency evidence. Missing or contradictory evidence withholds the unit, dividend amount and plotted fill price while preserving the original account fill. The original request and provider symbol must agree with the pin. Trade markers follow that same series and retain their account scope. |
| Live charts | Yahoo OHLC, the close-only fallback and Alpaca SIP add their observed identities to the same published claims. Alpaca adds the consolidated US region. Conflicting exact fund bars or directory entries withhold live prices even when the ISIN/MIC selector cannot use their prices. The chart returns HTTP 404 with `security-price-history-unavailable` and displays that the listing’s history is unavailable. |
| Technical and overview lenses | A timestamped regular price uses its own fundamentals currency and clock. A compact quote uses its own unit and observation date. A verified legacy ticker fallback requires a compatible currency. An old USD default can use the native major currency when the original unitless technical observation corroborates its price and date. The web header falls back to a market, technical or valuation observation with its own amount, unit and date. A missing unit withholds that price. The header, price previews, chart readings and technical figures display pence in pounds. Chart exports retain the source unit. The selected technical row supplies the score. The resolver supplies the schedule. Exact, validated earnings and analyst rows supply the next report date. A conflicting price pin withholds all four. Public previews carry the verified listing and its authorised aliases through daily and month-end analysis. A provider venue conflict withholds the preview’s schedule, quote and score. |
| Key moments | The dated-event join starts with the chart’s series and validates earnings, analyst and financial parents, calendar data, news and diagnostics. Each nested event inherits its parent’s claims and adds its own. A rejected analyst feed does not suppress independently corroborated news on a verified chart. |
| News, dividends and filings | Security news, dated financial evidence and the research journal prefer the qualified feed and can fall back to the verified legacy bar key when the qualified row is absent. Both the earnings parent and its nested calendar must agree before an ex-dividend date is used. Bar distributions retain the identity of their source series. |
| Analyst and earnings rows | Ratings, reported and projected earnings, the legacy events endpoint and the assistant’s stored lens validate parent rows before reading nested events. The overview, per-ticker snapshot and historical technical timeline use the same listing selection. The timeline compares both publications’ verified identities and authorised symbols, including changes in the storage key. |
| Daily and month-end completion | Technical research, benchmark and decision-price frames pass the requested symbol and observed provider evidence into calendar resolution. An unverified venue leaves the current close or final observed month pending. Verified early closes use the actual session close. |
| Live alert monitor | The provider symbol, exchange, original quote unit and timestamp accompany each live mark. Technical support, resistance, moving averages and option walls use a compatible mark converted to their own quote unit. Without that evidence the threshold uses the published price. Alert messages format the mark and its threshold in the same major currency. |
| Assistant valuation | A run checks its frozen listing pin, then validates the exact raw compact market and fundamental identities before using either quote in valuation evidence. |
| Options | The publisher verifies the underlying reported by Yahoo and by each expiry before computing exposures. The reader checks that stored evidence against the selected listing before projection. A labelled US ETF peer is checked against its own pin and must publish USD contracts. |
| Standalone estimate history | The read resolves the current listing and filters the archive by ticker and listing before applying the result limit. Without a publication, verified watchlist or qualified symbol evidence can still identify the archive listing. |
| Decision cache and timed review | Provider identities must agree before any bars can enter the cache or be reconciled to a broker fill. Cached provenance supplies the session matrix and review mark at the actual close, including early closes. |
| Published GBP benchmarks | ETF and FX legs each use completed daily observations before conversion. Each missing leg may carry its last close only across days when its own calendar has no session due. A pending FX close or missing ETF session withholds the conversion. US holidays can still contribute genuine FX-only observations. |
| Fundamentals and technical publishers | Yahoo symbols, MICs, short exchange codes, full exchange names and supplied market segments survive publication. Fundamentals retain conflicting claims with a warning. The technical publisher rejects incompatible history before computing scores. |

An untyped legacy fund can use the cash-session close when supported equity
and ETF cutoffs agree. An affirmative mutual-fund type or conflicting types
withhold timed leads. Vienna Global Market uses its segment-specific closing
auction when the publisher supplies the segment. The existing keyless Yahoo
data can omit it. On a documented normal session the resolver still dates
headlines before all candidate cutoffs and after all candidate cutoffs. It
withholds a date during the interval when applicable outcomes disagree.
[Vienna Stock Exchange trading hours](https://www.wienerborse.at/en/trading/trading-information/trading-hours/).

OTCQB and OTCQX retain separate MICs. London’s International Order Book spans
XLON and XLOM. OpenFIGI’s bare Taiwan composite covers both exchanges while the
qualified exchange names distinguish them. A supported venue identity can exist
without a verified timing rule.
[London Stock Exchange Stock Connect](https://www.londonstockexchange.com/en/our-regions/china/london-stock-connect)
and [OpenFIGI allocation rules](https://www.openfigi.com/about/allocation-rules).
