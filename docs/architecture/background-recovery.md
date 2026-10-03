# Incremental background recovery

Tracking: [bounded recovery maintenance #100](https://github.com/engramai-co/trading-max/issues/100).

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

Before compressed recovery activation, each distinct physical file is retained
once under `physical/<prefix>/<sha256>`. After activation, new files use streamed
gzip objects and bounded packing consolidates small objects without changing
their original SHA-256 identities. Unchanged captures reuse either representation.
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

One background invocation can reuse its successful independent verification for
subsequent retention and packing. The in-memory proof binds the complete manifest,
repository location, source identities (including inode, size, mtime and ctime)
and relevant compressed record locations. Descriptor/chunk closures also bind
their locator databases/WAL. Unrelated catalog appends do not invalidate a
direct blob's proof. Sources are compared before and after
verification; changed sources trigger full verification. Proofs never survive a
process restart and explicit `verify`/`restore` always read all original bytes.
Nightly retention holds deployment and repository locks continuously between
planning and removal, so historical reachability is scanned once. An externally
saved plan still requires a fresh eligibility scan before application.

Recovery readers from 1.9.11 can also reconstruct a sealed manifest's exact
original files from the existing gzip/blob or immutable-pack pool. A present
but corrupt raw copy remains an error; only an absent alias falls through.
Expanded size, original SHA-256, SQLite and the complete physical reference
graph are checked before restore publication. This reader rollout does not
automatically enable compression or retire raw recovery files. Compressed reuse
remains behind a separate policy; activation requires successful probes of the current
and two retained rollback recovery tools, including source deletion, locator
rebuild and a subsequent unchanged backup.

`tools/compress_recovery.py` checks the active state, a recovery point less than
24 hours old, full independent verification, and all three retained readers
under deployment/repository locks. Its `activate` command enables the policy;
`run` migrates bounded batches. Small raw aliases use the existing durable pack
journals. Large files stay streamed gzip objects with a separate retirement
journal and read-back checks. A corrupt original or compressed copy stops
retirement. An interrupted batch retains the original or the verified compressed
copy and resumes through its journal. Original manifests and dates stay unchanged.
No packing deletes unique history or changes chart data.

## Scheduling, priority and retention

The existing low-priority LaunchAgent checks every 15 minutes and at its daily
calendar time. It resumes queued checkpoints before creating a new daily point;
otherwise a verified point less than 24 hours old makes the check a no-op.
`background-status.json` records the last successful recovery, active/pending
phase, elapsed time and failures. Maintenance errors remain distinct from backup
success and are retried without creating another full recovery point.
Maintenance progress updates the same status and current elapsed time. A yielded
maintenance pass remains pending and resumes without capturing another backup.
Bounded unfinished packing/retention is also retried by the existing 15-minute
job, without waiting another day or producing another recovery point.

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
