# Incremental background recovery

Tracking: [backup maintenance issue #91](https://github.com/engramai-co/trading-max/issues/91).

Managed recovery preserves the existing physical chunks, compressed artifacts
and sealed packs. Expanding every historical JSON envelope reverses the store's
deduplication advantage in CPU work. The `sealed` recovery encoding keeps those
bytes and their SQLite locator together; it does not change application storage,
financial records, chart sampling or artifact identities.

## Checkpoint before cutover, archival after health

1. Build the candidate while the current service remains available.
2. Under the recovery repository lock, pin `latest.json`, capture SQLite databases
   through the online backup API (including WAL), then inventory physical files.
   Capture the pack locator before inventory so its referenced packs are included.
   Managed pack retirement takes the same lock. Concurrent publishers can append
   immutable files; changed files fail the capture safely.
3. Create independent APFS clones when supported, or independent file copies on
   other filesystems. Flush the tree, validate databases and the pinned current
   snapshot, then atomically publish a durable checkpoint queue item.
4. Switch the runtime, migrate, and pass readiness and smoke checks. Only then
   kick the existing launchd backup job. A failed kick leaves durable queued work;
   it does not roll back a healthy release.
5. Archive, verify and publish the complete recovery point in the background.
   A checkpoint is explicitly **queued**, not a fully verified repository backup.

The service remains available during checkpoint capture. The short cutover still
stops API/web/worker processes as before. The checkpoint protects pre-migration
state; an asynchronous backup of only the already-upgraded state would not.
There are no hard links between production data and recovery files. These are
local recovery copies, not protection against loss of the host or disk.

## Durable incremental work and verification

Each distinct physical file is retained once under `physical/<prefix>/<sha256>`.
The private `physical-journal.sqlite3` records completed capture identities in
durable batches. A timeout, SIGTERM or process restart can reuse completed files.
The journal is an acceleration index, never proof of recovery integrity.

Before publishing, independently read every repository file and compare its
size/SHA-256 with the checkpoint. Validate SQLite integrity and foreign keys,
pack checksums and record indexes, loose chunk hashes, artifact descriptors,
all retained snapshot/dependency references and the current snapshot. Each pack
or chunk is decoded once for closure validation, rather than once per historical
envelope that references it. Shared chunk paths are checked through a bounded,
scan-local cache; every descriptor still validates its references. The cache is
discarded before the next verification/restore. Reference validation reports
progress and honors interruption/deployment yields. No partial recovery manifest
is published.

Explicit `verify` and `restore` use the same physical verification. Restore writes
to a new, private staging directory and publishes only after successful checks.
It never overwrites live state. Old logical backups and tar archives remain
readable. New `sealed` manifests require the new recovery tool; restored state
uses the existing application storage format and can be checked by retained
object-pack-capable runtimes.

## Scheduling, priority and retention

The existing low-priority LaunchAgent checks every 15 minutes and at its daily
calendar time. It resumes queued checkpoints before creating a new daily point;
otherwise a verified point less than 24 hours old makes the check a no-op.
`background-status.json` records the last successful recovery, active/pending
phase, elapsed time and failures. Maintenance errors remain distinct from backup
success and are retried without creating another full recovery point.

A deployment request asks background work to yield at a safe file boundary.
The deployment lock wait is bounded to 30 seconds. An active deployment defers
new background work; after health acceptance, a brief startup wait allows the
deployer to release its lock. The deployment does not wait for archival completion.

Pending checkpoints survive failure. Their staging trees are removed only after
verified publication. Manifests share unchanged physical objects; existing date,
historical-coverage and rollback protections continue to apply. Orphan physical
objects require the same reviewed/grace-period retention rules as old blobs.
Old recovery points are not deleted simply because a new representation exists.
Temporary checkpoint space is separate from retained repository growth.

Secrets, environment files, logs and the existing disposable cache exclusions
remain outside recovery copies. Tests and public documentation use synthetic
data; production timing evidence belongs outside the repository.
