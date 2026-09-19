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
broker snapshot, account normalization, rolling intraday NAV and publication.
A full job has priority; live collection can retry a busy slot while that slot
is current, but never replay an expired slot as an observation.

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
`StageResult` artifacts. No shell script, subprocess bridge, or filesystem
glob participates in a refresh.

The worker owns snapshot publication. It publishes only after all requested
stages succeed, then starts additive LLM synthesis for nightly and on-demand
full snapshots. Live/intraday publication explicitly does not enqueue synthesis; it
inherits all unchanged artifact references from the previous complete snapshot.
A failed job leaves the previous successful snapshot untouched.

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
