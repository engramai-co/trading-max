# Trading 212 ingestion boundary

Trading Max has one canonical broker boundary:

- `backend/src/trading_max/ingestion/brokers/trading212.py` owns the allowlisted
  HTTP client, Keychain/environment credential lookup, official export polling,
  private account store, normalized broker contracts, and Decimal reconciliation.
- `backend/src/trading_max/application/broker_sync.py` owns the sync use case. It
  coordinates a native account snapshot, bounded annual exports, a deduplicated
  canonical ledger, strict position reconciliation, and manifest registration
  without parsing CLI stdout.
- No repository-shaped research script is part of the broker boundary. The
  typed broker adapter is the only production integration point.

## Safety boundary

The client permits:

1. `GET` account/position/order/history reads;
2. `POST /equity/history/exports`, which creates a read-only report request;
3. unauthenticated HTTPS download of the signed report URL.

Order placement, cancellation, and arbitrary URLs are rejected before any
network request. API credentials are never sent to the signed download host.

## Reconciliation policy

The native snapshot uses an explicit relative tolerance for broker rounding:

```text
max(£0.02, investment_value × 0.05%)
```

This addresses small FX/rounding differences without accepting a missing
position. Export reconciliation deduplicates overlapping windows by broker
transaction ID and compares the resulting ledger against live positions by
ISIN, falling back to broker ticker only when no ISIN exists.

Trading 212 rejects a single export whose range exceeds one year. The first
sync therefore starts with the latest year and automatically requests earlier
one-year slices while a live position still has an unexplained opening
balance. Slices are merged into one private canonical CSV. Later refreshes
reuse that verified ledger and merge only the new rolling export. The default
backfill floor is `2016-01-01` and can be changed with
`TRADING_MAX_BROKER_EXPORT_FLOOR`; reaching the floor without a match still
fails loudly.

The sync also caches the official cash-transaction feed. Account transfers
appear in both that feed and generated CSV reports, so historical NAV replay
reconciles matching business-day amounts before adding a supplemental flow;
it never counts the same transfer twice. Trading 212 CSV `Total` values are
already net account-currency cash amounts, including conversion fees, and the
separate fee column is retained for audit rather than deducted again.

The public API does not expose Trading 212 Card merchant payments. If an
account used the card and its generated report therefore cannot explain the
current broker cash balance, Trading Max still publishes the broker-native
terminal value but marks the historical account return series incomplete. It
does not spread the residual through history or publish fabricated TWR and
risk ratios. A manual Trading 212 history export containing `Card debit` rows
is required to make that account's historic cash flow complete.

The typed result is one of `verified`, `mismatch`, `unverified`, or
`unavailable`. Strict sync refuses to register a new export manifest unless it
is `verified`; the previous successful account snapshot therefore remains the
publishable state after a failed run.

## State location

Raw snapshots, exports, and manifests live below `T212_DATA_DIR` or the
platform default `~/.local/share/trading-max/trading212`, never in Git.
Managed directories are mode `0700`; files written by the adapter are mode
`0600` where the platform permits it. Production config places this state
directly under the shared Trading Max application-support root. The API and
worker only consume typed broker artifacts; no legacy path reader remains.
