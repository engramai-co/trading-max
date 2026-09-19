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

The nightly job automatically applies only backup-manifest and orphan-backup-blob
retention, after its new backup passes verification. Each night is bounded to
64 objects and 2 GB; its plan and removal journal are retained. Release directories,
legacy archives and rehearsals still require the reviewed operator procedure below.
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

Raw history retention and future immutable-history chunking require separate
data-migration validation. This maintenance does not shorten market or broker
history, interpolate missing observations, or alter financial calculations.

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
