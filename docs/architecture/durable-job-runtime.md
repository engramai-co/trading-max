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

The `intraday` trigger is a first-class lightweight job. It is admitted only
when no full refresh is active, while a full job may be admitted behind an
intraday job and is claimed first. The trigger runs broker snapshot, account
normalization, rolling intraday NAV, and publish stages only. Internal LLM
queue rows use the private `system` trigger and are excluded from refresh
status and scheduler admission.

## Execution plane

`services/api/trading_max_api/worker_main.py` is the macOS entry point for the
dedicated worker. It registers `TypedWorkerRuntime` from
`backend/src/trading_max` and executes only stages that return explicit
`StageResult` artifacts. No shell script, subprocess bridge, or filesystem
glob participates in a refresh.

The worker owns snapshot publication. It publishes only after all requested
stages succeed, then starts additive LLM synthesis for nightly and on-demand
full snapshots. Intraday publication explicitly does not enqueue synthesis; it
inherits all unchanged artifact references from the previous complete snapshot.
A failed job leaves the previous successful snapshot untouched.

## Cutover and rollback

`TRADING_MAX_EMBEDDED_WORKER` is only for tests or local development and remains
false on the host. Production uses
`com.engram.trading-max-worker` so API restarts cannot interrupt execution.

The deployment script installs/restarts the worker LaunchAgent when the plist
exists and removes it during rollback to a revision that predates the worker.
CI installs all uv workspace packages so the `trading_max` backend package is
available to both the API and worker LaunchAgents.
