# Durable job runtime

Trading Max refreshes are split into a control plane and an execution plane.

## Control plane

The API writes one row to `trading_max.db` and returns the API-compatible
`JobRecord`. It reads status and logs from the same durable record; it does not
run market downloads, account calculations, or research scripts in the request
process.

The queue uses SQLite WAL mode and an atomic claim lease. A worker can crash or
be restarted without leaving a permanently running job: an expired lease is
eligible for reclaim, and completed stages are skipped on retry. A follow-up
research request is persisted as a coalesced flag on the active job instead of
being held only in API memory.

`live` and its compatibility alias `intraday` are lightweight jobs. They run
broker snapshot, account normalization, rolling intraday NAV, day attribution
and publication. Live collection runs on its own worker lane so long main-lane
jobs (such as full reconciliations waiting for Trading 212 history exports) do
not block ten-minute observations. Each lane executes one job at a time.
Live requests check for queued or running live jobs, and main requests check
the main lane. Live collection retries while its slot is current. Expired
slots are skipped.

`performance` is a separate calculation job that reuses the latest live broker
snapshot rather than requesting another broker export. Scheduled `research`
also refreshes position-dependent look-through; official account reconciliation
uses the `accounts` path at its configured time. A manual `all` refresh combines
the full stage plan. Settings owns the three independent schedule preferences.
Internal LLM rows use the private `system` trigger and are excluded from refresh
status and scheduler admission.

## Execution plane

`services/api/trading_max_api/worker_main.py` is the cross-platform entry point for the
dedicated worker. It registers `TypedWorkerRuntime` from
`backend/src/trading_max` and executes only stages that return explicit
`StageResult` artifacts.

The dedicated worker and the embedded desktop worker use the same
trigger-isolated lanes. Each runtime shares one stage registry and
`Trading212BrokerSync` rate-limiter table. Each lane has its own SQLite
connection and heartbeat row.

- **Main lane** (`<worker_id>`) claims `on_demand`, `nightly`, `performance`,
  `research`, `reconciliation`.
- **Live lane** (`<worker_id>-live`) claims `intraday` and `live`.
- **Analysis lane** (`<worker_id>-analysis`) claims `system`.

Readiness reports the main lane and checks its live companion. SQLite busy
and locked errors retry with backoff capped at five seconds. A stopped,
missing, or stale live lane makes the worker unready. Both lanes share one
`Trading212RateLimiter` per environment and profile. Per-endpoint pacing and
account-wide HTTP 429 cooldowns apply across both threads, and each sync
opens its own HTTP client.

Each successful live job stores the latest verified observation per account
in its completion transaction. Summary-only observations leave that evidence
in place. When no account sync is active, the main lane compares the verified
observations with the published reconciliation. A persistent structural change
queues an account refresh and links the evidence to that job in the same
transaction. Failed requests become eligible again after a persisted retry
delay that doubles from 30 seconds up to 15 minutes. Evidence survives restart
and is removed when a successful reconciliation starts after it and covers
that account.

Before replacing `latest.json`, the publisher commits the intended run ID
with SQLite WAL syncing enabled for that transaction. A superseded snapshot
retains proof of publication until its manifest is pruned. If a lease is
reclaimed and the queue intent is missing, the worker looks for the job's
published run. If it finds none, it refuses to replace a snapshot newer than
the recovered inputs. Unpublished manifests stay out of history.

The worker checks for cancellation before the pointer swap. Once the run is
visible, the worker finishes the recorded run and saves account evidence in
the same transaction as job completion, retrying transient SQLite contention.

On desktop shutdown, all lanes share a 2.5-second deadline. The worker stop
signal interrupts Trading 212 export polling and pacing waits. Interrupted
jobs release their leases and preserve completed stages and pending broker
reports for the next run.

The worker owns snapshot publication. It publishes only after all requested
stages succeed, then starts additive LLM synthesis for nightly and on-demand
full snapshots. Live/intraday publication explicitly does not enqueue synthesis; it
inherits all unchanged artifact references from the previous complete snapshot.
A failed job leaves the previous successful snapshot untouched.

### Concurrent ordering and conflict rules

Because the main lane and the live lane can fetch broker data and publish
snapshots concurrently, these rules govern how both lanes write.

1. **Private broker files.** Each `ManagedAccountStore` JSON write uses a
   unique temporary file in the target directory (`0600`) and atomically
   replaces the destination, so concurrent snapshot writes never collide on a
   shared `.tmp` file. The lanes keep separate filenames for observations
   fetched in the same second. File-based lookups use fetch time, with live
   winning a tie. The main lane exclusively owns exports, `pending_export.json`,
   `latest_export.json` and `cash_transactions.json`; the live lane exclusively
   owns `live_cash_transactions.json`.
2. **Job-scoped account snapshots.** When a job runs `broker.sync`, its
   `accounts.snapshot` stage reads the exact upstream
   artifact emitted by that job. Reconciliations use
   `raw/trading212/{profile}.json` and live jobs use
   `raw/trading212/live/{profile}.json`. Live snapshots written during a
   long export wait (including unreconciled or post-trade snapshots) therefore
   cannot contaminate the main lane's ledger reconciliation, and vice versa.
   `skip_sync=True` jobs (`performance`, `research`) still read the latest
   snapshot on disk with the 30-minute reconciled fallback.
3. **Serialized snapshot publication.** `TypedPublishSnapshotStage` holds
   `SnapshotStore.publication_lock` from reading the latest manifest through
   reconciling artifacts and replacing `latest.json`. The lock serializes
   threads and processes and can be reacquired on the publishing thread.
   Each publication preserves artifact keys it does not update. API
   projections overlay live totals over canonical accounts only when live is
   newer.
4. **Precedence when both lanes publish the same artifact key.**
   - For `account/nav/valuation_history.json`, when the latest published history
     changed after `accounts.intraday_nav` ran, publication merges via
     `merge_valuation_history(..., replace_reconstructed=False)` using the
     maximum timestamp across both series. Live publications add their broker
     points onto the latest series without discarding main-lane reconstructed
     points; main publications retain all newer live broker points alongside
     their freshly reconstructed model points.
   - For `account/nav/cash_flows_{a,b}.json`, main-lane ledger reconciliation is
     authoritative whenever `source_digest`, `account_state_digest` or `events`
     differ. A live publication can advance `covered_until` if it extends
     the current artifact directly or carries the same verified evidence.
     A main publication preserves a strictly newer live extension when
     both histories are verified with identical digests and events.
   - `account/attribution/day_baseline.json` and `window_baselines.json`
     retain the latest trading day and use the earliest `captured_at`
     opening per account on that day.
   - `account/attribution/day.json` and `window.json` retain the latest trading
     day and use the newest account observation. An older summary-only
     observation leaves a newer verified row and its timestamp in place.
     When that row was attributed from a different opening, publication
     recalculates its contributions from the winning baseline or window chain.

## Cutover and rollback

`TRADING_MAX_EMBEDDED_WORKER` is only for tests or local development and remains
false in supported installations. The foreground launcher starts a separate
worker child. Local macOS login services use `com.engram.trading-max.local.worker`;
the advanced profile uses `com.engram.trading-max-worker`. API restarts therefore
do not own or interrupt worker execution. Do not mix the two service installers.

The advanced macOS deployer requires already provisioned API, web, and worker
services. It builds in isolation and retains the previous runtime and service
definitions; rollback restores them without rebuilding. This is a compatible
upgrade path, not an installer for a pre-worker deployment. See the
[deployment guide](../../deploy/macos/README.md).
CI installs all uv workspace packages so the `trading_max` backend package is
available to both the API and worker LaunchAgents.
