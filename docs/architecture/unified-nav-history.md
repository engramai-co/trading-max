# Unified account valuation history

## Decision

The portfolio value chart uses intraday valuations for 1D, 5D, 1M, 3M and 6M.
YTD follows its elapsed calendar span; spans longer than six months draw daily
observations, as do 1Y and All. Five days means five London weekdays;
monthly ranges retain calendar-month boundaries and fold weekends in the
display only. Cash events retain their original UTC timestamps.

Broker observations and ledger reconstructions share a typed, immutable history
artifact and the same merge policy. Observations take precedence in their
collection bucket; the modeled comparison value is retained for reconciliation.
Neither a missing quote nor a broker/model difference is classified as a return.
The existing daily CSV contract remains available to performance consumers.

The main valuation and cash-flow-adjusted P&L projection uses reconstructed
history only before the first usable broker observation. Once broker collection
starts, it uses broker observations exclusively, even when a collection slot is
missing. Determine that boundary over the full retained history before applying
the selected date range. This prevents differences between the provider's marks
and the broker's overnight marks from appearing as alternating profits and
drawdowns. All input observations and paired model comparisons remain unchanged
in the immutable artifact; this is source selection, not an outlier filter or a
price correction. A real spike in broker observations remains a real spike.

## Reconstruction

Replay official timestamped fills, split entries and native-currency cash events.
Value the resulting holdings and wallets using completed market/FX bars. Request
hourly history for the full retained window and five-minute history for the
recent provider-supported window. Evaluate the entire history every ten minutes,
independently of the chart range. Use only the last available completed price;
older marks may have hourly resolution, explicitly recorded separately from the
valuation cadence. This does not recreate missing ten-minute market prices.
Never interpolate daily closes or apply current holdings to past prices.

Include provider-supplied pre-market and after-hours bars. Keep the provider's
separate pre-market, regular and post-market boundaries when completing short
bars; a 09:00–09:30 pre-market bar is known at 09:30, not 10:00. The regular
session calendar still governs missing-bar detection. During quiet extended
sessions, carry the latest known trade, choosing the freshest timestamp across
hourly and five-minute feeds. This does not imply complete 24-hour coverage.
Regular-only caches remain separate; extended-hours reconstructions replace
their older regular-only counterparts while preserving broker observations.
The preview's live broker marks choose the newest available regular, pre-market
or post-market quote. The real broker collector retains its existing 24-hour
schedule and native account values.

Display one observation per fixed time bucket: 10 minutes for 1D, 30 minutes for
5D, one hour for 1M, two hours for 3M and four hours for 6M. Bucket boundaries
are anchored to UTC rather than the chosen window's start, so overlapping
ranges remain aligned across daylight-saving changes. Select the final real observation in
each bucket, retaining the first and last observed endpoints and source transitions.
Detect visual gaps after grouping at the selected display cadence: a bucket is
missing only when it contains no valid observation for that series. Isolated
ten-minute collection misses do not split populated 30-minute, hourly, two-hour
or four-hour buckets. The 1D view still exposes individual ten-minute misses;
daily views expose missing displayed days. YTD follows its selected cadence.
Do not select extra local extrema or change the interval to meet a point budget.
Coverage and all calculations, including drawdown extrema, use the full selected
history before display sampling. Display density never changes the stored
observations or their cadence. The transition from early reconstructed history
to broker collection and changes in contributions retain adjacent readings as
display anchors. Every bounded run of empty display buckets is connected by a separate dashed line using
only its two real endpoints. A separate, silent area layer connects the same
observations with a continuous faint fill, avoiding empty vertical strips under
each missed slot. Only the outline switches to dashes; helper layers supply no
tooltip readings, extra records or financial calculations. The observed solid
line keeps nulls for empty display buckets; original fine-grained gaps remain in
the retained history and coverage evidence. Leading and trailing gaps are not extrapolated. Only a history with
one observation needs a visible point marker. Keep authoritative broker values
and paired model values unchanged; do not smooth away their residual.

## Money and cash-flow basis

All money-chart ranges select the same underlying source precedence and verified
cash-flow cutoff. The long-range daily display uses the final eligible record
per London date, while calculations still use all eligible observations in the
selected period. Earlier genuine daily history can prefix 6M/YTD/long views
before intraday coverage begins; it is never interpolated or inserted into
missing broker slots. Adjacent daily fallback readings are not labelled as
missing ten-minute samples. TWR and risk consumers retain the independent,
reconciled daily NAV contract.

All ranges use the same four headline measures: ending account value, period net
contributions, period net P&L and maximum period P&L drawdown. Period net P&L is
ending value minus opening value minus net contributions during the interval.
Drawdown is measured from the running peak of that period P&L, using every stored
valuation before chart sampling. Percentage mode divides those changes by the
positive opening account value; it is not a time-weighted investment return.

The daily reconstruction publishes typed, immutable cash-flow evidence with each
event's broker timestamp and the exact GBP amount used by the daily NAV ledger.
The API projects cumulative contributions at each account's observation time;
only reconciled events within the evidence's covered interval qualify. Missing
evidence leaves P&L unavailable instead of treating contributions as zero. Daily
and intraday calculations share these amounts; intraday TWR remains unavailable.

An unchanged ledger and unchanged account cash and quantities allow a mark-only
refresh to extend existing cash-flow coverage without refetching market history.
This check runs on each live collection, using reconciled position detail and
each account's own observation time. Publish the extended evidence with the live
snapshot so the value curve, contribution line and P&L advance together.
Changed ledger sources or account balances require reconciliation again. The
source digest and account-state digest travel with each immutable evidence
artifact. Legacy value-only histories remain readable, without fabricated cash
flows or certification.

While new cash-flow evidence is genuinely pending, the money view retains its
original opening point but ends all three charts and all four headline metrics
at the last common verified observation. A compact timestamp identifies this
temporary cutoff. The overview still exposes the latest broker value. Never
carry unknown cash flows forward as zero or silently put different end times
beside one another. Orange cumulative-contribution steps use the same amounts
and semantics at every range; missing spans are separate from observed steps.

The overview chart shows period net P&L from zero, using the same cash-flow basis
and cutoff as the performance page. Valuation and contribution curves remain in
the detailed performance view. Missing observations are indicated by the dashed
outline, without a coverage badge, track or gap-count row. Individual sources, valuation cadence,
market-price resolution and extended-hours flags remain in the expandable records,
not the hover card. The title help defines valuations and the range calendar; the
sampling and reconstruction implementation belongs in this document.

The live collector stays lightweight. Full account refreshes backfill market
history and reconcile ledger quantities; live refreshes append broker values
through the same history writer. The default retention is 210 days to cover six
calendar months with a reconciliation buffer. Market history caches live outside the checkout and are reused across
accounts. Missing market coverage must not prevent collecting broker values.
Deployments with an explicit older retention override must raise it to 210 days
to retain the full 6M window; a shorter user-configured window stays supported
and is presented as partial coverage.

## Compatibility and migration

Old intraday artifacts remain readable. Their observations migrate in memory on
the next publication; immutable snapshots and source artifacts are not rewritten.
Daily NAV and intraday API fields remain compatible projections, with additive
source, precision and model-comparison metadata. Reconstruction does not certify
cash-flow-adjusted returns: the existing reconciled daily performance path stays
authoritative until event-time unitization is implemented and independently
validated.

## Privacy, validation and rollback

Use synthetic ledgers, quotes and account observations in automated tests.
In the interactive preview, simulate only Trading 212 account inputs. Market
prices, FX, research and ETF constituents must use the production provider
adapters. Reconstruct preview NAV from the simulated ledger and observed prices;
never generate a market-price path or fill missing provider data with fixtures.
Keep the preview in a separate external state root, and replace an old fully
synthetic snapshot with a clean provider-backed publication instead of merging
its market artifacts. The preview builder refuses an unmarked state directory.
Cover intraday buys/sells, cash flows, split and currency handling, unavailable
prices, no lookahead, source precedence, restart/idempotency, retention, calendar
boundaries and API compatibility. Compare reconstructed and broker values without
spreading residuals over history. Roll back the application revision without
deleting external state; previous artifacts remain readable.
