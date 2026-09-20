# Storage maintenance and recovery copies

This procedure is for the operator-managed [macOS service](../../deploy/macos/README.md).
Keep application state and this repository outside Git. A local recovery copy
protects against an upgrade mistake; copy the whole backup repository off-host
to protect against loss of the machine or disk. Credentials remain in their
original credential store and private bootstrap directory.

## Independent deduplicated backups

Deployments and the installed nightly LaunchAgent use
`service-root/backups/repository`. Each immutable manifest identifies compressed,
SHA-256-checked file blobs. Unchanged files are shared between backup manifests,
but never linked to live application files. SQLite is captured with its online
backup API. The published pointer is pinned before the file inventory. Missing
references, changed files or failed verification stop publication without
pruning any older backup. A concurrent publisher can require a retry.

The backup validates every file's size and digest, SQLite integrity, snapshot
references and the current snapshot's artifact identities. It stores no secrets,
environment files or logs. Old `trading_max-*.tar.gz` archives remain supported
by [the archive restore tool](../../tools/restore_backup.py).

Run these commands with the installed release's Python; `SERVICE_ROOT` and
`STATE_ROOT` below are operator-selected absolute paths, not new defaults:

```bash
"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/manage_backups.py" \
  --repository "$SERVICE_ROOT/backups/repository" create \
  --state-root "$STATE_ROOT" --label manual

"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/manage_backups.py" \
  --repository "$SERVICE_ROOT/backups/repository" verify BACKUP_ID

"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/manage_backups.py" \
  --repository "$SERVICE_ROOT/backups/repository" restore BACKUP_ID /absolute/new-recovery-state
```

Restore only accepts a new destination. It verifies into a private staging
directory before atomically publishing the restored state. It never overwrites
running state or replaces credentials. Validate the recovered snapshot before
an operator selects it as the runtime state root. `backup.sh` still supports
legacy archive mode for an explicit invocation; the installed LaunchAgent sets
`TRADING_MAX_BACKUP_FORMAT=repository`.

## Plan, verify, clean in small batches

The retention tool protects the active release and two successive rollback
targets, unfinished deployment recovery records, and any release with running
processes. Git changes or untracked files prevent release cleanup. It retains
the newest three recovery snapshots plus seven daily, four weekly and six
monthly representatives, as well as backups referenced by protected deployments.
Legacy deployment archives retain at least the newest three plus weekly/monthly
representatives and protected rollback copies.

Cleanup fingerprints verify the content of shared, read-only Node executables;
removing another release alias must not stop an otherwise unchanged batch.
Changes to contents, permissions or source identity still invalidate the plan.

Date buckets are a minimum recovery set. Retention also keeps the newest
additional points needed to preserve every original file digest under
`artifacts/`, `snapshots/`, `imports/`, legacy `trading212/` and `raw/` sources,
and lossless archive-compatibility supplements. Equal paths with different bytes are
conservatively retained. Unique history can therefore keep more points than
the date policy alone; capacity warnings never override this protection.

The nightly job applies backup-manifest, orphan-backup-blob, old unprotected
release and unreferenced shared Node retention after its new backup passes verification. Each night is bounded
to 64 objects and 2 GB; its plan and removal journal are retained. Current and both
rollback runtimes remain protected. Legacy archives and rehearsals still require
the reviewed operator procedure below.
An explicitly overridden backup destination is not automatically pruned.

Candidates must be at least 24 hours old. Unknown directories, application
snapshots, artifacts, database, broker inputs, credentials and rehearsal trees
are excluded. Orphan backup blobs are collectible only when no existing backup
manifest references them; retiring a manifest and collecting its blobs require
separate plans. This is not application-artifact garbage collection.

```bash
"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/service_retention.py" \
  --service-root "$SERVICE_ROOT" plan --output /private/path/cleanup-plan.json

"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/service_retention.py" \
  --service-root "$SERVICE_ROOT" apply --plan /private/path/cleanup-plan.json \
  --verified-backup-id BACKUP_ID --max-items 2 --max-bytes 5000000000
```

Review the generated candidate paths and byte counts before applying. Apply
requires a recovery snapshot of the active application's state from the last
24 hours and verifies it again; a backup of an unrelated rehearsal cannot qualify.
The deployment lock and repository lock prevent concurrent changes. Deployment
changes, changed target metadata or a plan older than 24 hours stop cleanup.
Regenerate the plan after each batch and check readiness before continuing.

Each target is atomically detached into a private `maintenance/<id>` directory,
then removed. A JSON journal records the original path and result. Recovery
records whose runtimes were removed are marked retired. If interrupted, inspect
the journal and any remaining quarantine data before resuming maintenance;
subsequent cleanup refuses to proceed while a journal remains unfinished.
Never remove an arbitrary directory based only on its size or age.

Recovery retention and physical history conversion are separate operations.
The lossless chunk migration below has its own reader, backup and byte-parity
gates. Routine retention does not shorten market or broker history, interpolate
missing observations, or alter financial calculations.

New releases pin the Node executable in `toolchains/node-blobs/<sha256>` and
retain a hard link at each release's `.node-runtime/node`. The shared executable
is copied independently from the external source, checksum-verified and made
read-only; a source upgrade cannot rewrite retained runtimes. Unsupported hard
links fall back to independent copies. Old pool objects qualify for cleanup only
when no runtime links remain, their checksum still matches, and the 24-hour
grace has elapsed. Application state and recovery data never share these links.

## Import an existing recovery date

`import-archive` accepts a dated `trading_max-YYYYMMDDTHHMMSSZ.tar.gz` and leaves
it intact. It streams files into the same independent blob repository, validates
paths and byte budgets, and verifies the database and snapshot before publishing.
Repeated imports of the same archive reuse its manifest. `createdAt` remains the
original UTC recovery date; `importedAt` records the separate import time.

```bash
"$SERVICE_ROOT/app/.venv/bin/python" "$SERVICE_ROOT/app/tools/manage_backups.py" \
  --repository "$SERVICE_ROOT/backups/repository" import-archive \
  /private/backups/trading_max-20260102T043000Z.tar.gz --max-bytes 68719476736
```

Restore the imported ID into a new directory and compare every restored file
with the archive before retiring that exact source archive. Import does not
remove it or qualify as a fresh backup of the active application state. Budget
restored temporary space and process one archive at a time. The archive digest
and original name remain in the manifest for the deletion journal.

## History representation compatibility

See [immutable history storage](../architecture/history-storage.md). The default
writer remains legacy. An operator can use `TRADING_MAX_HISTORY_STORAGE=shadow`
to verify chunked representations while retaining complete original objects.
Reads and downloads support both forms; backups include physical dependencies.
Do not opt into `chunked` writes until the active and both protected rollback
releases have the dual reader and have passed restore validation. This release
never automatically migrates or deletes existing application objects.

## Lossless representation migration

`tools/compact_storage.py --service-root SERVICE check-readers` exercises the
current runtime and both retained rollback runtimes against synthetic compact
artifacts, snapshot indexes, filing caches and independent backup recovery.
Missing or incompatible rollback readers block mutation. Legacy writing remains
the default until this check succeeds; do not bypass it by changing environment
variables on an incompatible installation.

After a fresh, verified recovery snapshot exists, use the `state` or `backups`
subcommand with `--state-root STATE --verified-backup-id ID`. Both operations
accept `--max-files` and `--max-bytes` to bound each run. They acquire the service
deployment lock and coordinate with the recovery repository lock. Inspect their
JSON reports before increasing an initial migration's budget.

State migration preserves artifact identities, exact original envelope bytes,
all historical records and immutable filing text. A prepared journal precedes
each atomic replacement. Restart reconciles interrupted entries; unexpected
content stops the run. A failed verification restores the original content.
Mutable filing result caches are allowed to expire and rewrite normally, rather
than being raced by the migration. No unique financial observations are pruned.

Recovery compaction shares independently owned blocks while retaining original
manifest IDs, recovery dates and file SHA-256 values. Each original compressed
blob is retired only after the replacement reproduces every original byte. A
failed replacement is removed so it cannot hide the valid original recovery
blob. Re-running a completed batch is safe; repeated observations are shared,
not interpolated or downsampled. Directory entries are synced after publication
so a crash cannot publish a descriptor before its durable block writes.

The managed nightly and deployment backups use `--artifact-encoding logical`.
They recover each JSON artifact as its exact original envelope, so old full JSON
and new live descriptors share one independent recovery representation. Physical
live chunks are not copied a second time. Binary source artifacts, SQLite and
all non-artifact files keep their existing byte-preserving contract. Original
artifact IDs, amounts, timestamps and provenance remain unchanged. Existing
physical backup manifests remain valid and are never rewritten.

Each full backup verification uses a fresh 16 MiB byte cache, bounded to 512
entries, for unchanged chunks already read and checksum-verified during that
operation. File identity changes invalidate a cache hit. This does not persist
verification results across backups or skip original-file checksum, SQLite,
or snapshot validation.

The library and manual CLI retain `physical` as their default. A logical restore
materializes full JSON envelopes; allow their reported `logicalBytes` on the
recovery disk, then use the verified state compactor if desired. The current and
both protected rollback runtimes must support packed recovery before enabling
this mode. Deleting the live state does not affect the independent backup.


## Daily installation budget

The default complete installation budget is 5,000,000,000 bytes, configurable with
`TRADING_MAX_STORAGE_BUDGET_BYTES`. The daily census includes live state, all
recovery copies, all retained releases, service tools/rehearsals, logs and the
legacy archive directory. It measures both file lengths and allocated blocks,
deduplicates hard links and does not count the app symlink again. Unclassified
files inside the service directory remain included. Global shared developer-tool
caches outside these roots are not attributed to this installation.

The nightly repository workflow also limits the publicly retrievable filing
cache to 250 MB, with a 24-hour grace period and a per-run maximum of 256 files or
128 MiB. Recently accessed filing documents are retained first. Broker exports,
original account observations, quote history and application snapshots are never
cache-eviction candidates. New backups omit only the disposable disclosures
cache; old recovery manifests and archives retain their exact restore contract.

Reports live in `maintenance/storage-budget/latest.json` under the service root
and `runtime/storage-budget.json` under state. `trading-max doctor` shows the last
census and reports an exceeded budget. A bounded 90-day history estimates growth
from seven-day observations. Thresholds are watch at 70%, warning at 80%, critical
at 90%, and over-budget above 100%. A census can be refreshed with
`tools/storage_budget.py --service-root SERVICE --state-root STATE`.

This is a capacity policy, not permission to erase permanent financial records.
If unique records eventually approach the budget, archive or expand storage
before the reserve is exhausted. Maintenance must report any remaining excess
rather than silently downsample observations or stop account ingestion. Fresh
builds and recovery validation require temporary headroom beyond normal steady
state; do not provision a filesystem with only 5 GB of free space.
