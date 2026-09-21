# Space and time maintenance decision record

Decision accepted: 2026-09-19. Implementation status reviewed: 2026-09-21.

The sections below preserve the design constraints. The core changes now ship
in 1.5.x–1.7.x; storage activation remains operator-managed. This record is not
a list of pending migrations. Use the current procedures linked below.

## Implementation map

| Decision | Current implementation and source of truth |
|---|---|
| Transfer only the selected view | [Interface lenses and pinned history](interface-lenses.md), including separate chart and exact-record requests |
| Reuse history without changing values | [History formats and derived query index](history-storage.md) |
| Consolidate immutable files and backup manifests | [Object packs and recovery catalogs](immutable-object-packs.md); activation follows reader and restore checks |
| Independent recovery and bounded cleanup | [Storage maintenance](../operations/storage-maintenance.md), including plan/apply, unique-history retention and nightly limits |
| Account for the complete installation | [Capacity policy](../operations/storage-maintenance.md#daily-installation-budget), including retained runtimes, recovery, logs and growth alerts |

A smaller payload is a transfer-size improvement. It does not alone establish a
browser latency improvement; use the same client, route, network and cold/warm
conditions when comparing elapsed times.

## Motivation and scope

Production measurements found repeated full-state deployment backups, retained
release runtimes, and page lenses shipping unused research and account history.
Improve transfer sizes and local recoverability before removing historical copies.
Network-path stalls are a separate measured problem; API timings alone cannot
certify browser latency or establish a Tailscale root cause.

## Compatibility and financial correctness

Keep the complete dashboard and immutable raw records. Add optional range/scope
projections to page lenses, with query identities including every selection.
Keep source-boundary anchors outside the requested window: trimming those would
incorrectly let reconstructed values replace missing broker observations.
Do not downsample the inputs to P&L or drawdown calculations. Display sampling
continues separately; reducing downloaded fields is preferable to losing extrema.
Daily risk history remains available when the selected money window is short.

## Recovery and retention

Replace repeated full deployment archives with an independently stored,
content-addressed backup repository. Immutable backup manifests reference
compressed file blobs. SQLite uses its online backup API; credentials and logs
are excluded. Existing tar archives remain readable and are kept during rollout.
Publish a backup only after verifying its files, SQLite integrity and snapshot
references. A failed write or verification must not remove any previous backup.

Cleanup is a separate, bounded plan/apply operation, under the deployment lock.
Protect the active runtime, retained rollback targets, recent verified backups,
and interrupted deployment recovery records. Revalidate the plan before removal,
keep an external deletion journal, and stop on changed or unknown paths. Never
use an mtime or a file-count estimate as proof that business data is disposable.
Application snapshots, broker inputs, artifacts, secrets and jobs are not release
garbage. A rehearsal requires independent evidence before disposal.

## Alternatives and acceptance

Lowering archive counts alone still duplicates the entire store on every release.
Hard-linking backups to live artifacts shares corruption risk; independent,
compressed backup blobs avoid that dependency. Historical artifact chunking is
a separate migration: retain current artifact identities and old-runtime recovery
until that migration has its own compatibility proof.

Use synthetic fixtures for window boundaries, source transitions, cash flows,
backup corruption, broken references, concurrent cleanup, stale plans and restore.
Measure production bytes and bounded serial timings before/after; check readiness,
worker state and version, then gradually remove only verified cleanup candidates.
No real account records, credentials or production reports enter Git.
