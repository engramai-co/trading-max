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

## Listing venue resolution

Use `trading_max.research.venues.resolve_venue(requested, *claims)` wherever
published or live evidence is matched to a listing. Pass the original requested
symbol, including its suffix. Each `VenueClaim(source, value, listing)` names
the namespace and the symbol to which the evidence belongs. `row_claims` builds
claims for a price row and its exact fundamentals. `watchlist_claims` handles
stored provider codes, legacy display names and the generated market default.

The result contains the compatible MICs in `venues`, a `conflict` flag and the
verified session `calendar` when available. Intersect explicit evidence,
including qualified symbols. Apply a market default only when its own symbol
has no explicit venue. A bare US request can therefore reject a different
London listing, while a stored default on a qualified London symbol yields
to that symbol. Nasdaq listing tiers have distinct MICs and share a schedule.
An unknown provider code leaves timed evidence without a calendar. Conflicting
verified claims make the price unavailable and withhold venue-dependent events.

Yahoo suffixes, Yahoo codes and names, OpenFIGI exchange codes and ISO MICs
have their own mappings. For example, OpenFIGI `BO` identifies B3 Soma, while
the Yahoo suffix `.BO` identifies Bombay. Issuer domicile, quote currency and
time zone do not identify the venue. Exchange provenance on new watchlist
entries is optional for compatibility with older snapshots.
