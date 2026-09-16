# Unified account valuation history

## Decision

The portfolio value chart uses intraday valuations for 1D, 5D, 1M and 3M.
Longer ranges use daily valuations. Five days means five London weekdays;
monthly ranges retain calendar-month boundaries and fold weekends in the
display only. Cash events retain their original UTC timestamps.

Broker observations and ledger reconstructions share a typed, immutable history
artifact and the same merge policy. Observations take precedence in their
collection bucket; the modeled comparison value is retained for reconciliation.
Neither a missing quote nor a broker/model difference is classified as a return.
The existing daily CSV contract remains available to performance consumers.

## Reconstruction

Replay official timestamped fills, split entries and native-currency cash events.
Value the resulting holdings and wallets using completed market/FX bars. Request
hourly history for the full three-month window and five-minute history for the
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
5D, one hour for 1M and two hours for 3M. Select the final real observation in
each bucket, retaining segment endpoints, collection gaps and source transitions.
Do not select extra local extrema or change the interval to meet a point budget.
Coverage and all calculations, including drawdown extrema, use the complete
ten-minute history. Display density never changes the stored observations or
their cadence. Source changes retain both adjacent readings as display anchors,
but do not break the line: only absent observations make a gap. Keep authoritative
broker values and paired model values unchanged; do not smooth away their residual.

The default chart shows valuations and financial measures. Normal coverage does
not need a status badge or track. Show coverage only when data is incomplete,
including a single missing slot or stale tail. Individual sources, valuation cadence,
market-price resolution and extended-hours flags remain in the expandable records,
not the hover card. The title help defines valuations and the range calendar; the
sampling and reconstruction implementation belongs in this document.

The live collector stays lightweight. Full account refreshes backfill market
history and reconcile ledger quantities; live refreshes append broker values
through the same history writer. Retain at least 120 days to cover three calendar
months. Market history caches live outside the checkout and are reused across
accounts. Missing market coverage must not prevent collecting broker values.
Deployments with an explicit older retention override must raise it to 120 days
to retain the full 3M window; a shorter user-configured window stays supported
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
